import { randomUUID } from 'node:crypto';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AuditEntry } from '../src/audit/audit-entry.schema.js';
import { RefreshTokensRepository } from '../src/auth/refresh-tokens.repository.js';
import { TokensService } from '../src/auth/tokens.service.js';
import { UsersRepository } from '../src/users/users.repository.js';
import {
  addMember,
  agentFor,
  as,
  DEFAULT_PASSWORD,
  signIn,
  signUp,
  withSession,
  type Actor,
} from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface ListedSession {
  id: string;
  startedAt: string;
  lastRefreshedAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers['set-cookie'] as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith('mecm_refresh='));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie.split(';')[0];
}

describe('sessions (e2e)', () => {
  let ctx: TestApp;
  let audit: Model<AuditEntry>;

  beforeAll(async () => {
    ctx = await createTestApp();
    audit = ctx.app.get(getModelToken(AuditEntry.name));
  });

  afterAll(async () => {
    await ctx.stop();
  });

  async function device(user: Actor, userAgent: string): Promise<Actor> {
    const agent = agentFor(ctx);
    const res = await agent
      .post('/api/v1/auth/sign-in')
      .set('User-Agent', userAgent)
      .send({ email: user.email, password: user.password })
      .expect(200);
    return { ...user, token: res.body.accessToken, agent };
  }

  async function sessionsOf(actor: Actor): Promise<ListedSession[]> {
    const res = await withSession(actor).get('/api/v1/auth/sessions').expect(200);
    return res.body.items as ListedSession[];
  }

  function reuseAlarms(userId: string) {
    return audit.countDocuments({
      action: 'TOKEN_REUSE_DETECTED',
      'actor.id': new Types.ObjectId(userId),
    });
  }

  describe('own sessions', () => {
    it('lists each sign-in as a session and marks the one of the refresh cookie as current', async () => {
      const user = await signUp(ctx);
      const laptop = await device(user, 'Laptop/1.0\t(Test)');
      const res = await withSession(user).get('/api/v1/auth/sessions').expect(200);
      expect(res.body.accessTokenTtlSeconds).toBe(3600);
      const items = res.body.items as ListedSession[];
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.id).toMatch(UUID);
        expect(Object.keys(item).sort()).toEqual(
          ['current', 'expiresAt', 'id', 'lastRefreshedAt', 'startedAt', 'userAgent'].sort(),
        );
      }
      expect(items.filter((s) => s.current)).toHaveLength(1);
      const other = items.find((s) => !s.current) as ListedSession;
      expect(other.userAgent).toBe('Laptop/1.0 (Test)');

      const fromLaptop = await sessionsOf(laptop);
      expect(fromLaptop.find((s) => s.current)?.id).toBe(other.id);

      const bare = await as(ctx, user).get('/api/v1/auth/sessions').expect(200);
      expect((bare.body.items as ListedSession[]).every((s) => !s.current)).toBe(true);
      const stranger = await signUp(ctx);
      const foreign = await stranger.agent
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);
      expect(foreign.body.items).toHaveLength(2);
      expect((foreign.body.items as ListedSession[]).every((s) => !s.current)).toBe(true);
    });

    it('keeps the start of a session across refreshes and moves its last refresh', async () => {
      const user = await signUp(ctx);
      const [before] = await sessionsOf(user);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const refreshed = await user.agent
        .post('/api/v1/auth/refresh')
        .set('User-Agent', 'Refreshed/3.0')
        .expect(200);
      const [after] = await sessionsOf({ ...user, token: refreshed.body.accessToken });
      expect(after.userAgent).toBe('Refreshed/3.0');
      expect(after.id).toBe(before.id);
      expect(after.startedAt).toBe(before.startedAt);
      expect(Date.parse(after.lastRefreshedAt)).toBeGreaterThan(Date.parse(before.lastRefreshedAt));
      expect(after.current).toBe(true);
    });

    it('stores a user agent capped at 200 characters and none when the header is missing', async () => {
      const user = await signUp(ctx);
      await device(user, `Long/${'x'.repeat(400)}`);
      const sessions = await sessionsOf(user);
      const long = sessions.find((s) => s.userAgent?.startsWith('Long/'));
      expect(long?.userAgent).toHaveLength(200);
    });

    it('revokes another session: its refresh fails, no reuse alarm, and the revoke is audited', async () => {
      const user = await signUp(ctx);
      const phone = await device(user, 'Phone/2.0');
      const sessions = await sessionsOf(user);
      const current = sessions.find((s) => s.current) as ListedSession;
      const other = sessions.find((s) => !s.current) as ListedSession;

      const refused = await withSession(user)
        .delete(`/api/v1/auth/sessions/${current.id}`)
        .expect(400);
      expect(refused.body.code).toBe('CURRENT_SESSION');
      await withSession(user).delete(`/api/v1/auth/sessions/${other.id}`).expect(204);

      await phone.agent.post('/api/v1/auth/refresh').expect(401);
      expect(await reuseAlarms(user.userId)).toBe(0);
      await as(ctx, phone).get('/api/v1/auth/me').expect(200);
      expect((await sessionsOf(user)).map((s) => s.id)).toEqual([current.id]);

      const entry = await audit
        .findOne({ action: 'SESSION_REVOKED', 'resource.id': user.userId })
        .lean();
      expect(entry).toMatchObject({
        actor: { email: user.email },
        resource: { type: 'user', id: user.userId, label: user.email },
        context: { sessionId: other.id, scope: 'one', count: 1 },
      });

      await withSession(user).delete(`/api/v1/auth/sessions/${other.id}`).expect(404);
      await withSession(user).delete(`/api/v1/auth/sessions/${randomUUID()}`).expect(404);
      const malformed = await withSession(user)
        .delete('/api/v1/auth/sessions/not-a-uuid')
        .expect(400);
      expect(malformed.body.code).toBe('VALIDATION_FAILED');
    });

    it('revokes all other sessions and keeps the current one', async () => {
      const user = await signUp(ctx);
      const a = await device(user, 'A/1');
      const b = await device(user, 'B/1');
      const res = await withSession(user).delete('/api/v1/auth/sessions').expect(200);
      expect(res.body).toEqual({ revoked: 2 });
      await a.agent.post('/api/v1/auth/refresh').expect(401);
      await b.agent.post('/api/v1/auth/refresh').expect(401);
      await user.agent.post('/api/v1/auth/refresh').expect(200);
      expect(await reuseAlarms(user.userId)).toBe(0);
      const entry = await audit
        .findOne({ action: 'SESSION_REVOKED', 'resource.id': user.userId })
        .lean();
      expect(entry?.context).toEqual({ sessionId: null, scope: 'others', count: 2 });

      const again = await withSession(user).delete('/api/v1/auth/sessions').expect(200);
      expect(again.body).toEqual({ revoked: 0 });
      expect(
        await audit.countDocuments({ action: 'SESSION_REVOKED', 'resource.id': user.userId }),
      ).toBe(1);
    });

    it('lets members manage their own sessions and never another tenant’s', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const memberPhone = await device(member, 'MemberPhone/1');
      const [phoneSession] = (await sessionsOf(memberPhone)).filter((s) => s.current);

      const outsider = await signUp(ctx);
      const theirs = await sessionsOf(outsider);
      expect(theirs.map((s) => s.id)).not.toContain(phoneSession.id);
      await withSession(outsider).delete(`/api/v1/auth/sessions/${phoneSession.id}`).expect(404);
      await withSession(admin).delete(`/api/v1/auth/sessions/${phoneSession.id}`).expect(404);
      await memberPhone.agent.post('/api/v1/auth/refresh').expect(200);

      await withSession(member).delete(`/api/v1/auth/sessions/${phoneSession.id}`).expect(204);
    });

    it('cuts off every earlier access token when the password changes', async () => {
      const user = await signUp(ctx);
      const other = await signIn(ctx, user.email, user.password);
      const changed = await as(ctx, user)
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: user.password, newPassword: 'NewPassw0rd!' })
        .expect(200);
      await as(ctx, other).get('/api/v1/auth/me').expect(401);
      await as(ctx, user).get('/api/v1/auth/me').expect(401);
      await as(ctx, { token: changed.body.accessToken }).get('/api/v1/auth/me').expect(200);
    });
  });

  describe("a member's sessions (admins)", () => {
    it('lists them without a current flag, for admins only', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      await device(member, 'Second/1');
      const res = await withSession(admin)
        .get(`/api/v1/members/${member.userId}/sessions`)
        .expect(200);
      expect(res.body.accessTokenTtlSeconds).toBe(3600);
      expect(res.body.items).toHaveLength(2);
      expect((res.body.items as ListedSession[]).every((s) => !s.current)).toBe(true);

      const denied = await as(ctx, member)
        .get(`/api/v1/members/${admin.userId}/sessions`)
        .expect(403);
      expect(denied.body.code).toBe('FORBIDDEN');
      expect(
        await audit.countDocuments({
          action: 'ACCESS_DENIED',
          'actor.id': new Types.ObjectId(member.userId),
          'context.attemptedAction': 'sessions.manage',
        }),
      ).toBe(1);
      await as(ctx, member).delete(`/api/v1/members/${admin.userId}/sessions`).expect(403);
      await as(ctx, member)
        .delete(`/api/v1/members/${admin.userId}/sessions/${randomUUID()}`)
        .expect(403);
      await as(ctx, admin)
        .get(`/api/v1/members/${new Types.ObjectId().toHexString()}/sessions`)
        .expect(404);
      await as(ctx, admin).get('/api/v1/members/not-an-id/sessions').expect(404);
    });

    it('revokes one session of the member, scoped to that member', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const colleague = await addMember(ctx, admin);
      const [session] = (await as(ctx, admin).get(`/api/v1/members/${member.userId}/sessions`)).body
        .items as ListedSession[];
      await as(ctx, admin)
        .delete(`/api/v1/members/${colleague.userId}/sessions/${session.id}`)
        .expect(404);
      await as(ctx, admin)
        .delete(`/api/v1/members/${member.userId}/sessions/${session.id}`)
        .expect(204);
      await member.agent.post('/api/v1/auth/refresh').expect(401);
      await as(ctx, admin)
        .delete(`/api/v1/members/${member.userId}/sessions/${session.id}`)
        .expect(404);
      await as(ctx, admin).delete(`/api/v1/members/${member.userId}/sessions/nope`).expect(400);
      const entry = await audit
        .findOne({ action: 'SESSION_REVOKED', 'resource.id': member.userId })
        .lean();
      expect(entry).toMatchObject({
        actor: { email: admin.email },
        resource: { type: 'user', id: member.userId, label: member.email },
        context: { sessionId: session.id, scope: 'one', count: 1 },
      });
    });

    it('revokes all sessions of the member and cuts off their access tokens at once', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const second = await device(member, 'Second/1');
      const res = await as(ctx, admin)
        .delete(`/api/v1/members/${member.userId}/sessions`)
        .expect(200);
      expect(res.body).toEqual({ revoked: 2 });
      await as(ctx, member).get('/api/v1/auth/me').expect(401);
      await as(ctx, second).get('/api/v1/auth/me').expect(401);
      await member.agent.post('/api/v1/auth/refresh').expect(401);
      await second.agent.post('/api/v1/auth/refresh').expect(401);
      expect(await reuseAlarms(member.userId)).toBe(0);
      const entry = await audit
        .findOne({ action: 'SESSION_REVOKED', 'resource.id': member.userId })
        .lean();
      expect(entry?.context).toEqual({ sessionId: null, scope: 'all', count: 2 });

      const back = await signIn(ctx, member.email, DEFAULT_PASSWORD);
      await as(ctx, back).get('/api/v1/auth/me').expect(200);

      await as(ctx, admin).delete(`/api/v1/members/${member.userId}/sessions`).expect(200);
      const empty = await as(ctx, admin)
        .delete(`/api/v1/members/${member.userId}/sessions`)
        .expect(200);
      expect(empty.body).toEqual({ revoked: 0 });
      await as(ctx, back).get('/api/v1/auth/me').expect(401);
      const all = await audit
        .find({ action: 'SESSION_REVOKED', 'resource.id': member.userId })
        .sort({ createdAt: 1, _id: 1 })
        .lean();
      expect(all.map((e) => e.context)).toEqual([
        { sessionId: null, scope: 'all', count: 2 },
        { sessionId: null, scope: 'all', count: 1 },
        { sessionId: null, scope: 'all', count: 0 },
      ]);
    });

    it("never lists or revokes another tenant's sessions", async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const [session] = (await as(ctx, admin).get(`/api/v1/members/${member.userId}/sessions`)).body
        .items as ListedSession[];
      const other = await signUp(ctx);
      await as(ctx, other).get(`/api/v1/members/${member.userId}/sessions`).expect(404);
      await as(ctx, other)
        .delete(`/api/v1/members/${member.userId}/sessions/${session.id}`)
        .expect(404);
      await as(ctx, other).delete(`/api/v1/members/${member.userId}/sessions`).expect(404);
      await as(ctx, other)
        .delete(`/api/v1/members/${other.userId}/sessions/${session.id}`)
        .expect(404);
      await as(ctx, member).get('/api/v1/auth/me').expect(200);
      await member.agent.post('/api/v1/auth/refresh').expect(200);
    });
  });

  describe('rotation racing a revoke', () => {
    async function refreshWhileRevoked(
      admin: Actor,
      member: Actor,
      cookie: string,
    ): Promise<number> {
      const [session] = (await as(ctx, admin).get(`/api/v1/members/${member.userId}/sessions`)).body
        .items as ListedSession[];
      const tokens = ctx.app.get(TokensService);
      const issue = tokens.issueRefreshToken.bind(tokens);
      let revoked = 0;
      const spy = vi.spyOn(tokens, 'issueRefreshToken').mockImplementationOnce(async (...args) => {
        revoked = (
          await as(ctx, admin).delete(`/api/v1/members/${member.userId}/sessions/${session.id}`)
        ).status;
        return issue(...args);
      });
      try {
        const res = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', cookie);
        expect(revoked).toBe(204);
        expect(spy).toHaveBeenCalledTimes(1);
        return res.status;
      } finally {
        spy.mockRestore();
      }
    }

    it('refuses the rotation that finishes after the revoke (normal path)', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const signedIn = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .send({ email: member.email, password: member.password })
        .expect(200);
      await member.agent.post('/api/v1/auth/sign-out').expect(204);

      expect(await refreshWhileRevoked(admin, member, cookieOf(signedIn))).toBe(401);
      const left = await as(ctx, admin).get(`/api/v1/members/${member.userId}/sessions`);
      expect(left.body.items).toEqual([]);
      expect(await reuseAlarms(member.userId)).toBe(0);
    });

    it('refuses the access token of a refresh that completed while an admin revoked all sessions', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const sessions = ctx.app.get(RefreshTokensRepository, { strict: false });
      const revokeAll = sessions.revokeAllForUser.bind(sessions);
      let raced: { status: number; token?: string } = { status: 0 };
      const spy = vi.spyOn(sessions, 'revokeAllForUser').mockImplementationOnce(async (...args) => {
        const res = await member.agent.post('/api/v1/auth/refresh');
        raced = { status: res.status, token: res.body.accessToken as string | undefined };
        return revokeAll(...args);
      });
      try {
        await as(ctx, admin).delete(`/api/v1/members/${member.userId}/sessions`).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(raced.status).toBe(200);
      await as(ctx, { token: raced.token as string })
        .get('/api/v1/auth/me')
        .expect(401);
      await member.agent.post('/api/v1/auth/refresh').expect(401);
    });

    it('refuses a refresh whose access token is signed after a revoke-all landed', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const users = ctx.app.get(UsersRepository, { strict: false });
      const findById = users.findById.bind(users);
      let revoked = 0;
      const spy = vi.spyOn(users, 'findById').mockImplementation(async (...args) => {
        const read = await findById(...args);
        if (revoked === 0 && args[1] === member.userId) {
          revoked = -1;
          revoked = (await as(ctx, admin).delete(`/api/v1/members/${member.userId}/sessions`))
            .status;
        }
        return read;
      });
      let res: { status: number; body: { accessToken?: string } };
      try {
        res = await member.agent.post('/api/v1/auth/refresh');
      } finally {
        spy.mockRestore();
      }
      expect(revoked).toBe(200);
      expect(res.status).toBe(401);
    });

    it('refuses the rotation that finishes after the revoke (grace path)', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const first = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .send({ email: member.email, password: member.password })
        .expect(200);
      await member.agent.post('/api/v1/auth/sign-out').expect(204);
      const stale = cookieOf(first);
      await ctx.http().post('/api/v1/auth/refresh').set('Cookie', stale).expect(200);

      expect(await refreshWhileRevoked(admin, member, stale)).toBe(401);
      const left = await as(ctx, admin).get(`/api/v1/members/${member.userId}/sessions`);
      expect(left.body.items).toEqual([]);
    });
  });
});
