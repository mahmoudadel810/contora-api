import { Injectable } from '@nestjs/common';
import type { QueryFilter, UpdateQuery } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { toObjectId } from '../database/object-id.js';
import type { User, UserDocument } from '../users/user.schema.js';
import { UsersRepository } from '../users/users.repository.js';
import { actorOf, type Principal } from './principal.js';
import {
  RefreshTokensRepository,
  type RevokeAllOptions,
  type StoredSession,
} from './refresh-tokens.repository.js';
import { TokensService } from './tokens.service.js';

export interface ListedSession {
  id: string;
  startedAt: string;
  lastRefreshedAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

export interface SessionList {
  items: ListedSession[];
  accessTokenTtlSeconds: number;
}

export type RevokeScope = 'one' | 'others' | 'all';

function toSessionView(session: StoredSession, currentId: string | null): ListedSession {
  return {
    id: session.familyId,
    startedAt: session.startedAt.toISOString(),
    lastRefreshedAt: session.lastRefreshedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    userAgent: session.userAgent,
    current: session.familyId === currentId,
  };
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly sessions: RefreshTokensRepository,
    private readonly tokens: TokensService,
    private readonly users: UsersRepository,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  async listOwn(principal: Principal, cookie: string | undefined): Promise<SessionList> {
    return this.list(principal.tenantId, principal.userId, await this.currentId(principal, cookie));
  }

  async revokeOwn(principal: Principal, sessionId: string, cookie: string | undefined) {
    if ((await this.currentId(principal, cookie)) === sessionId) {
      throw errors.badRequest(
        'CURRENT_SESSION',
        'This is the session you are using; sign out instead',
      );
    }
    await this.revokeOne(principal, principal.userId, principal.email, sessionId);
  }

  async revokeOthers(principal: Principal, cookie: string | undefined) {
    const currentId = await this.currentId(principal, cookie);
    const revoked = await this.endAll(principal.tenantId, principal.userId, {
      exceptFamilyId: currentId ?? undefined,
    });
    await this.recordRevoke(principal, principal.userId, principal.email, {
      sessionId: null,
      scope: 'others',
      count: revoked,
    });
    return { revoked };
  }

  async listFor(principal: Principal, userId: string): Promise<SessionList> {
    const user = await this.requireManaged(principal, userId);
    return this.list(principal.tenantId, user.id as string, null);
  }

  async revokeFor(principal: Principal, userId: string, sessionId: string): Promise<void> {
    const user = await this.requireManaged(principal, userId);
    await this.revokeOne(principal, user.id as string, user.email, sessionId);
  }

  async revokeAllFor(principal: Principal, userId: string): Promise<{ revoked: number }> {
    const user = await this.requireManaged(principal, userId);
    const { user: cut, revoked } = await this.cutOff(principal.tenantId, user.id as string);
    if (!cut) throw errors.notFound('Member');
    await this.recordRevoke(
      principal,
      user.id as string,
      user.email,
      { sessionId: null, scope: 'all', count: revoked },
      true,
    );
    return { revoked };
  }

  endAll(tenantId: string, userId: string, options: RevokeAllOptions = {}): Promise<number> {
    return this.sessions.revokeAllForUser(tenantId, userId, options);
  }

  async cutOff(
    tenantId: string,
    userId: string,
    write: { filter?: QueryFilter<User>; update?: UpdateQuery<User> } = {},
    options: Pick<RevokeAllOptions, 'startedBefore'> = {},
  ): Promise<{ user: UserDocument | null; revoked: number }> {
    const revoked = await this.endAll(tenantId, userId, options);
    const user = await this.users.updateOne(
      tenantId,
      { ...write.filter, _id: toObjectId(userId) },
      { ...write.update, tokensValidAfter: new Date() },
    );
    return { user, revoked };
  }

  private async list(
    tenantId: string,
    userId: string,
    currentId: string | null,
  ): Promise<SessionList> {
    const sessions = await this.sessions.listSessions(tenantId, userId);
    return {
      items: sessions.map((session) => toSessionView(session, currentId)),
      accessTokenTtlSeconds: this.tokens.accessTokenTtlSeconds,
    };
  }

  private async revokeOne(
    principal: Principal,
    userId: string,
    email: string,
    sessionId: string,
  ): Promise<void> {
    if (!(await this.sessions.revokeSession(principal.tenantId, userId, sessionId))) {
      throw errors.notFound('Session');
    }
    await this.recordRevoke(principal, userId, email, { sessionId, scope: 'one', count: 1 });
  }

  private async recordRevoke(
    principal: Principal,
    userId: string,
    email: string,
    context: { sessionId: string | null; scope: RevokeScope; count: number },
    changedAnyway = false,
  ): Promise<void> {
    if (context.count === 0 && !changedAnyway) return;
    await this.audit.record(principal.tenantId, {
      action: 'SESSION_REVOKED',
      actor: actorOf(principal),
      resource: { type: 'user', id: userId, label: email },
      context,
    });
  }

  private async currentId(principal: Principal, cookie: string | undefined) {
    const session = await this.tokens.sessionOf(cookie);
    if (
      !session ||
      session.tenantId !== principal.tenantId ||
      session.userId !== principal.userId
    ) {
      return null;
    }
    return session.familyId;
  }

  private async requireManaged(principal: Principal, userId: string): Promise<UserDocument> {
    await this.policy.authorize(principal, 'sessions.manage', { type: 'user', id: userId });
    const user = await this.users.findById(principal.tenantId, userId);
    if (!user) throw errors.notFound('Member');
    return user;
  }
}
