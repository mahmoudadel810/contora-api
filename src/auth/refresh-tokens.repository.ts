import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage, QueryFilter } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { toObjectId } from '../database/object-id.js';
import { RefreshToken } from './refresh-token.schema.js';

export interface StoredSession {
  familyId: string;
  startedAt: Date;
  lastRefreshedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
}

export interface RevokeAllOptions {
  exceptFamilyId?: string;
  startedBefore?: Date;
}

const REVOKE: PipelineStage[] = [
  { $set: { familyRevoked: true, revokedAt: { $ifNull: ['$revokedAt', '$$NOW'] } } },
];

@Injectable()
export class RefreshTokensRepository extends TenantRepository<RefreshToken> {
  constructor(@InjectModel(RefreshToken.name) model: Model<RefreshToken>) {
    super(model);
  }

  private live(userId: string, extra: QueryFilter<RefreshToken> = {}): QueryFilter<RefreshToken> {
    return {
      ...extra,
      userId: toObjectId(userId),
      familyRevoked: false,
      expiresAt: { $gt: new Date() },
    };
  }

  async listSessions(tenantId: string, userId: string): Promise<StoredSession[]> {
    const rows = await this.model
      .aggregate<{
        _id: string;
        sessionStartedAt: Date | null;
        firstCreatedAt: Date;
        lastRefreshedAt: Date;
        expiresAt: Date;
        userAgent: string | null;
      }>([
        { $match: this.scope(tenantId, this.live(userId)) },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $group: {
            _id: '$familyId',
            sessionStartedAt: { $min: '$sessionStartedAt' },
            firstCreatedAt: { $min: '$createdAt' },
            lastRefreshedAt: { $max: '$createdAt' },
            expiresAt: { $max: '$expiresAt' },
            userAgent: { $first: '$userAgent' },
          },
        },
        { $sort: { lastRefreshedAt: -1, _id: 1 } },
      ])
      .exec();
    return rows.map((row) => ({
      familyId: row._id,
      startedAt: row.sessionStartedAt ?? row.firstCreatedAt,
      lastRefreshedAt: row.lastRefreshedAt,
      expiresAt: row.expiresAt,
      userAgent: row.userAgent ?? null,
    }));
  }

  async revokeSession(tenantId: string, userId: string, familyId: string): Promise<boolean> {
    return (await this.updateMany(tenantId, this.live(userId, { familyId }), REVOKE)) > 0;
  }

  async revokeAllForUser(
    tenantId: string,
    userId: string,
    options: RevokeAllOptions = {},
  ): Promise<number> {
    const which: QueryFilter<RefreshToken> = {
      ...(options.exceptFamilyId ? { familyId: { $ne: options.exceptFamilyId } } : {}),
      ...(options.startedBefore
        ? {
            $or: [
              { sessionStartedAt: { $lt: options.startedBefore } },
              { sessionStartedAt: null, createdAt: { $lt: options.startedBefore } },
            ],
          }
        : {}),
    };
    const families = await this.distinct(tenantId, 'familyId', this.live(userId, which));
    await this.updateMany(
      tenantId,
      { ...which, userId: toObjectId(userId), familyRevoked: false },
      REVOKE,
    );
    return families.length;
  }

  async revokeFamily(tenantId: string, familyId: string): Promise<void> {
    await this.updateMany(tenantId, { familyId }, REVOKE);
  }

  familyRevoked(tenantId: string, familyId: string): Promise<boolean> {
    return this.exists(tenantId, { familyId, familyRevoked: true });
  }
}
