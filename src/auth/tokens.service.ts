import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { z } from 'zod';
import { errors } from '../common/errors.js';
import { APP_CONFIG, durationToSeconds, type AppConfig } from '../config/env.js';
import { toObjectId } from '../database/object-id.js';
import { RefreshToken, type RefreshTokenDocument } from './refresh-token.schema.js';
import { RefreshTokensRepository } from './refresh-tokens.repository.js';

const AccessPayloadSchema = z.object({
  sub: z.string().min(1),
  tid: z.string().min(1),
  iat: z.number(),
  exp: z.number().optional(),
});

export type AccessPayload = z.infer<typeof AccessPayloadSchema>;

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export interface SessionOrigin {
  familyId?: string;
  startedAt?: Date;
  userAgent?: string | null;
}

export type RotationResult =
  | {
      status: 'rotated';
      userId: string;
      tenantId: string;
      familyId: string;
      next: IssuedRefreshToken;
    }
  | { status: 'reused'; userId: string; tenantId: string }
  | { status: 'invalid' };

export interface SessionRef {
  tenantId: string;
  userId: string;
  familyId: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ROTATION_GRACE_MS = 30_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issuedAtMs(payload: Pick<AccessPayload, 'iat'>): number {
  return Math.round(payload.iat * 1000);
}

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    @InjectModel(RefreshToken.name)
    private readonly refreshTokens: Model<RefreshToken>,
    private readonly sessions: RefreshTokensRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get accessTokenTtlSeconds(): number {
    return durationToSeconds(this.config.JWT_EXPIRES_IN);
  }

  issueAccessToken(userId: string, tenantId: string): string {
    return this.jwt.sign(
      { sub: userId, tid: tenantId, iat: Date.now() / 1000 } satisfies AccessPayload,
      { expiresIn: this.accessTokenTtlSeconds },
    );
  }

  verifyAccessToken(token: string): AccessPayload {
    let decoded: unknown;
    try {
      decoded = this.jwt.verify(token);
    } catch {
      throw errors.unauthorized('Invalid or expired access token');
    }
    const parsed = AccessPayloadSchema.safeParse(decoded);
    if (!parsed.success) throw errors.unauthorized('Invalid or expired access token');
    const { sub, tid, iat, exp } = parsed.data;
    return exp === undefined ? { sub, tid, iat } : { sub, tid, iat, exp };
  }

  async issueRefreshToken(
    userId: string,
    tenantId: string,
    origin: SessionOrigin = {},
  ): Promise<IssuedRefreshToken> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS);
    await this.sessions.create(tenantId, {
      userId: toObjectId(userId),
      familyId: origin.familyId ?? randomUUID(),
      tokenHash: hashToken(token),
      expiresAt,
      revokedAt: null,
      rotatedAt: null,
      familyRevoked: false,
      userAgent: origin.userAgent ?? null,
      sessionStartedAt: origin.startedAt ?? now,
    });
    return { token, expiresAt };
  }

  async rotate(token: string, userAgent: string | null = null): Promise<RotationResult> {
    const existing = await this.find(token);
    if (!existing || existing.expiresAt.getTime() <= Date.now()) return { status: 'invalid' };
    const userId = existing.userId.toHexString();
    const tenantId = existing.tenantId.toHexString();
    const origin: SessionOrigin & { familyId: string } = {
      familyId: existing.familyId,
      startedAt: existing.sessionStartedAt ?? existing.createdAt,
      userAgent: userAgent ?? existing.userAgent,
    };
    const claimed = await this.sessions.updateOne(
      tenantId,
      { _id: existing._id, revokedAt: null },
      { revokedAt: new Date(), rotatedAt: new Date() },
    );
    if (!claimed) {
      const current = await this.sessions.findById(tenantId, existing.id as string);
      if (!current) return { status: 'invalid' };
      if (this.withinRotationGrace(current)) {
        return this.issueNext(userId, tenantId, origin);
      }
      if (current.rotatedAt === null) return { status: 'invalid' };
      await this.sessions.revokeFamily(tenantId, existing.familyId);
      return { status: 'reused', userId, tenantId };
    }
    return this.issueNext(userId, tenantId, origin);
  }

  private async issueNext(
    userId: string,
    tenantId: string,
    origin: SessionOrigin & { familyId: string },
  ): Promise<RotationResult> {
    const next = await this.issueRefreshToken(userId, tenantId, origin);
    if (await this.familyRevoked(tenantId, origin.familyId)) {
      await this.sessions.revokeFamily(tenantId, origin.familyId);
      return { status: 'invalid' };
    }
    return { status: 'rotated', userId, tenantId, familyId: origin.familyId, next };
  }

  familyRevoked(tenantId: string, familyId: string): Promise<boolean> {
    return this.sessions.familyRevoked(tenantId, familyId);
  }

  async revoke(token: string): Promise<RefreshTokenDocument | null> {
    const existing = await this.find(token);
    if (existing) {
      await this.sessions.revokeFamily(existing.tenantId.toHexString(), existing.familyId);
    }
    return existing;
  }

  async sessionOf(token: string | undefined): Promise<SessionRef | null> {
    if (!token) return null;
    const existing = await this.find(token);
    if (!existing) return null;
    return {
      tenantId: existing.tenantId.toHexString(),
      userId: existing.userId.toHexString(),
      familyId: existing.familyId,
    };
  }

  private withinRotationGrace(token: RefreshTokenDocument): boolean {
    return (
      !token.familyRevoked &&
      token.rotatedAt !== null &&
      Date.now() - token.rotatedAt.getTime() <= ROTATION_GRACE_MS
    );
  }

  private find(token: string): Promise<RefreshTokenDocument | null> {
    return this.refreshTokens.findOne({ tokenHash: hashToken(token) }).exec();
  }
}
