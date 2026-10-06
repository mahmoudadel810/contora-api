import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { compare, hash } from 'bcryptjs';
import { Model } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import { errors } from '../common/errors.js';
import { toObjectId } from '../database/object-id.js';
import { slugify, Tenant, toTenantView, type TenantView } from '../tenants/tenant.schema.js';
import type { Role } from '../users/role.js';
import { toUserView, type UserDocument, type UserView } from '../users/user.schema.js';
import { UsersRepository } from '../users/users.repository.js';
import type { ChangePasswordInput, SignInInput, SignUpInput } from './auth.dto.js';
import { actorOf, type Actor, type Principal } from './principal.js';
import { SessionsService } from './sessions.service.js';
import { TokensService, type IssuedRefreshToken } from './tokens.service.js';

const BCRYPT_ROUNDS = 10;

const DUMMY_HASH = hash(randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

const SELF = { withSignIn: true } as const;

export interface SessionView {
  user: UserView;
  tenant: TenantView;
  accessToken: string;
  expiresIn: number;
}

export interface IssuedSession {
  view: SessionView;
  refresh: IssuedRefreshToken;
}

function actorOfUser(user: UserDocument): Actor {
  return {
    id: user._id.toHexString(),
    email: user.email,
    displayName: user.displayName,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    @InjectModel(Tenant.name) private readonly tenants: Model<Tenant>,
    private readonly tokens: TokensService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  hashPassword(password: string): Promise<string> {
    return hash(password, BCRYPT_ROUNDS);
  }

  async comparePassword(password: string, passwordHash: string | null): Promise<boolean> {
    const matches = await compare(password, passwordHash ?? (await DUMMY_HASH));
    return passwordHash !== null && matches;
  }

  async signUp(input: SignUpInput, userAgent: string | null = null): Promise<IssuedSession> {
    if (await this.users.emailTaken(input.email)) {
      throw errors.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    const tenant = await this.tenants.create({
      name: input.tenantName,
      slug: await this.uniqueSlug(slugify(input.tenantName)),
    });
    const tenantId = tenant._id.toHexString();
    const user = await this.users.create(tenantId, {
      email: input.email,
      passwordHash: await this.hashPassword(input.password),
      displayName: input.displayName,
      role: 'admin',
      status: 'active',
      lastSignInAt: new Date(),
      tokensValidAfter: null,
    });
    await this.audit.record(tenantId, {
      action: 'SIGN_UP',
      actor: actorOfUser(user),
      resource: { type: 'tenant', id: tenantId, label: tenant.name },
    });
    return this.issue(user, userAgent);
  }

  async createMember(
    tenantId: string,
    input: { email: string; password: string; displayName: string; role: Role },
    options: { signingIn?: boolean } = {},
  ): Promise<UserDocument> {
    if (await this.users.emailTaken(input.email)) {
      throw errors.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    return this.users.create(tenantId, {
      email: input.email,
      passwordHash: await this.hashPassword(input.password),
      displayName: input.displayName,
      role: input.role,
      status: 'active',
      lastSignInAt: options.signingIn ? new Date() : null,
      tokensValidAfter: null,
    });
  }

  async signIn(input: SignInInput, userAgent: string | null = null): Promise<IssuedSession> {
    const startedAt = new Date();
    const user = await this.users.findByEmailAcrossTenants(input.email);
    const matches = await compare(input.password, user?.passwordHash ?? (await DUMMY_HASH));
    const valid = user !== null && user.status === 'active' && matches;
    if (!user || !valid) {
      if (user) await this.recordSignInFailed(user, input.email);
      throw errors.unauthorized('Invalid email or password');
    }
    const tenantId = user.tenantId.toHexString();
    const session = await this.issue(user, userAgent);
    const signedIn = await this.users.updateOne(
      tenantId,
      {
        _id: user._id,
        status: 'active',
        passwordHash: user.passwordHash,
        $or: [{ tokensValidAfter: null }, { tokensValidAfter: { $lte: startedAt } }],
      },
      { lastSignInAt: new Date() },
    );
    if (!signedIn) {
      await this.tokens.revoke(session.refresh.token);
      const now = await this.users.findById(tenantId, user.id as string);
      await this.recordSignInFailed(now ?? user, input.email);
      throw errors.unauthorized('Invalid email or password');
    }
    await this.audit.record(tenantId, {
      action: 'SIGN_IN',
      actor: actorOfUser(signedIn),
    });
    return { ...session, view: { ...session.view, user: toUserView(signedIn, SELF) } };
  }

  private async recordSignInFailed(user: UserDocument, email: string): Promise<void> {
    await this.audit.record(user.tenantId.toHexString(), {
      action: 'SIGN_IN_FAILED',
      actor: actorOfUser(user),
      context: { email, reason: user.status === 'active' ? 'credentials' : 'inactive' },
    });
  }

  async issueFor(user: UserDocument, userAgent: string | null = null): Promise<IssuedSession> {
    return this.issue(user, userAgent);
  }

  async refresh(
    refreshToken: string | undefined,
    userAgent: string | null = null,
  ): Promise<IssuedSession> {
    if (!refreshToken) throw errors.unauthorized('No session');
    const result = await this.tokens.rotate(refreshToken, userAgent);
    if (result.status === 'invalid') throw errors.unauthorized('Session expired');
    const user = await this.users.findById(result.tenantId, result.userId);
    if (result.status === 'reused') {
      await this.audit.record(result.tenantId, {
        action: 'TOKEN_REUSE_DETECTED',
        actor: user ? actorOfUser(user) : null,
        context: { effect: 'all sessions in the token family were revoked' },
      });
      throw errors.unauthorized('Session expired');
    }
    if (!user || user.status !== 'active') throw errors.unauthorized('Session expired');
    const view = await this.view(user);
    if (await this.tokens.familyRevoked(result.tenantId, result.familyId)) {
      throw errors.unauthorized('Session expired');
    }
    return { view, refresh: result.next };
  }

  async signOut(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const revoked = await this.tokens.revoke(refreshToken);
    if (!revoked) return;
    const user = await this.users.findById(
      revoked.tenantId.toHexString(),
      revoked.userId.toHexString(),
    );
    await this.audit.record(revoked.tenantId.toHexString(), {
      action: 'SIGN_OUT',
      actor: user ? actorOfUser(user) : null,
    });
  }

  async me(principal: Principal): Promise<{ user: UserView; tenant: TenantView }> {
    const user = await this.requireUser(principal);
    return {
      user: toUserView(user, SELF),
      tenant: await this.tenantView(principal.tenantId),
    };
  }

  async updateProfile(principal: Principal, displayName: string): Promise<UserView> {
    const user = await this.users.updateById(principal.tenantId, principal.userId, { displayName });
    if (!user) throw errors.unauthorized();
    return toUserView(user, SELF);
  }

  async changePassword(
    principal: Principal,
    input: ChangePasswordInput,
    userAgent: string | null = null,
  ): Promise<IssuedSession> {
    const user = await this.requireUser(principal);
    if (!(await compare(input.currentPassword, user.passwordHash))) {
      throw errors.badRequest('WRONG_PASSWORD', 'Current password is incorrect');
    }
    const passwordHash = await this.hashPassword(input.newPassword);
    const { user: updated } = await this.sessions.cutOff(principal.tenantId, principal.userId, {
      update: { passwordHash },
    });
    if (!updated) throw errors.unauthorized();
    await this.sessions.endAll(principal.tenantId, principal.userId);
    await this.audit.record(principal.tenantId, {
      action: 'PASSWORD_CHANGED',
      actor: actorOf(principal),
      resource: { type: 'user', id: principal.userId, label: principal.email },
      context: { otherSessionsRevoked: true },
    });
    return this.issue(updated, userAgent);
  }

  private async issue(user: UserDocument, userAgent: string | null): Promise<IssuedSession> {
    const refresh = await this.tokens.issueRefreshToken(
      user._id.toHexString(),
      user.tenantId.toHexString(),
      { userAgent },
    );
    return { view: await this.view(user), refresh };
  }

  private async view(user: UserDocument): Promise<SessionView> {
    return {
      user: toUserView(user, SELF),
      tenant: await this.tenantView(user.tenantId.toHexString()),
      accessToken: this.tokens.issueAccessToken(
        user._id.toHexString(),
        user.tenantId.toHexString(),
      ),
      expiresIn: this.tokens.accessTokenTtlSeconds,
    };
  }

  private async tenantView(tenantId: string): Promise<TenantView> {
    const tenant = await this.tenants.findById(toObjectId(tenantId)).exec();
    if (!tenant) throw errors.unauthorized();
    return toTenantView(tenant);
  }

  private async requireUser(principal: Principal): Promise<UserDocument> {
    const user = await this.users.findById(principal.tenantId, principal.userId);
    if (!user) throw errors.unauthorized();
    return user;
  }

  private async uniqueSlug(base: string): Promise<string> {
    let candidate = base;
    let suffix = 2;
    while (await this.tenants.exists({ slug: candidate })) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}
