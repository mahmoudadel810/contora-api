import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type { AuditAction } from '../src/audit/audit-action.js';
import { AuditEntry } from '../src/audit/audit-entry.schema.js';
import { RefreshTokensRepository } from '../src/auth/refresh-tokens.repository.js';
import { Invitation } from '../src/members/invitation.schema.js';
import { UsersRepository } from '../src/users/users.repository.js';
import {
  addMember,
  agentFor,
  as,
  DEFAULT_PASSWORD,
  signIn,
  signUp,
  type Actor,
} from './helpers/actors.js';
import { createRecord, grantRootEdit, workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

type Listed = { id: string; status: string; role: string; lastSignInAt?: string | null };

function tokenOf(acceptUrl: string): string {
  return new URL(acceptUrl).searchParams.get('token') as string;
}

describe('member status, sign-in times and rejoining (e2e)', () => {
  let ctx: TestApp;
  let audit: Model<AuditEntry>;
  let invitations: Model<Invitation>;
  let users: UsersRepository;

  beforeAll(async () => {
    ctx = await createTestApp();
    audit = ctx.app.get(getModelToken(AuditEntry.name));
    invitations = ctx.app.get(getModelToken(Invitation.name));
    users = ctx.app.get(UsersRepository, { strict: false });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  function entries(action: AuditAction, userId: string) {
    return audit.find({ action, 'resource.id': userId }).lean();
  }

  async function memberOf(admin: Actor, id: string): Promise<Listed> {
    const list = await as(ctx, admin).get('/api/v1/members').expect(200);
    return (list.body as Listed[]).find((u) => u.id === id) as Listed;
  }

  describe('suspend', () => {
    it('stops the member at once: bearer, refresh and sign-in all fail, and it is audited', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const res = await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      expect(res.body).toMatchObject({ id: member.userId, status: 'suspended', role: 'member' });
      expect(typeof res.body.lastSignInAt).toBe('string');

      await as(ctx, member).get('/api/v1/auth/me').expect(401);
      await member.agent.post('/api/v1/auth/refresh').expect(401);
      const signInRes = await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .send({ email: member.email, password: member.password })
        .expect(401);
      expect(signInRes.body.message).toBe('Invalid email or password');
      const failed = await audit
        .findOne({ action: 'SIGN_IN_FAILED', 'actor.email': member.email })
        .lean();
      expect(failed?.context).toEqual({ email: member.email, reason: 'inactive' });

      const suspended = await entries('MEMBER_SUSPENDED', member.userId);
      expect(suspended).toHaveLength(1);
      expect(suspended[0]).toMatchObject({
        actor: { email: admin.email },
        resource: { type: 'user', label: member.email },
        context: { role: 'member' },
      });
      expect((await memberOf(admin, member.userId)).status).toBe('suspended');
      const overview = await as(ctx, admin).get('/api/v1/admin/overview').expect(200);
      expect(overview.body.members).toMatchObject({ active: 1, suspended: 1, removed: 0 });

      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      expect(await entries('MEMBER_SUSPENDED', member.userId)).toHaveLength(1);
    });

    it('refuses yourself, members and foreign ids, and role changes of suspended members', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const self = await as(ctx, admin).post(`/api/v1/members/${admin.userId}/suspend`).expect(400);
      expect(self.body.code).toBe('CANNOT_SUSPEND_SELF');

      for (const verb of ['suspend', 'reactivate']) {
        await as(ctx, member).post(`/api/v1/members/${admin.userId}/${verb}`).expect(403);
      }
      expect(
        await audit.countDocuments({
          action: 'ACCESS_DENIED',
          'actor.id': new Types.ObjectId(member.userId),
          'context.attemptedAction': 'members.manage',
        }),
      ).toBe(2);

      const other = await signUp(ctx);
      for (const verb of ['suspend', 'reactivate']) {
        await as(ctx, other).post(`/api/v1/members/${member.userId}/${verb}`).expect(404);
        await as(ctx, admin)
          .post(`/api/v1/members/${new Types.ObjectId().toHexString()}/${verb}`)
          .expect(404);
        await as(ctx, admin).post(`/api/v1/members/nope/${verb}`).expect(404);
      }
      expect((await memberOf(admin, member.userId)).status).toBe('active');

      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      const role = await as(ctx, admin)
        .patch(`/api/v1/members/${member.userId}`)
        .send({ role: 'admin' })
        .expect(409);
      expect(role.body.code).toBe('MEMBER_SUSPENDED');
      await as(ctx, other).post(`/api/v1/members/${member.userId}/reactivate`).expect(404);
      expect((await memberOf(admin, member.userId)).status).toBe('suspended');
    });
  });

  describe('reactivate', () => {
    it('lets the member sign in again but keeps access tokens from before the suspension dead', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      const res = await as(ctx, admin)
        .post(`/api/v1/members/${member.userId}/reactivate`)
        .expect(200);
      expect(res.body).toMatchObject({ id: member.userId, status: 'active', role: 'member' });

      await as(ctx, member).get('/api/v1/auth/me').expect(401);
      await member.agent.post('/api/v1/auth/refresh').expect(401);
      const back = await signIn(ctx, member.email, DEFAULT_PASSWORD);
      await as(ctx, back).get('/api/v1/auth/me').expect(200);

      const reactivated = await entries('MEMBER_REACTIVATED', member.userId);
      expect(reactivated).toHaveLength(1);
      expect(reactivated[0].context).toEqual({ role: 'member' });

      const again = await as(ctx, admin)
        .post(`/api/v1/members/${member.userId}/reactivate`)
        .expect(200);
      expect(again.body.status).toBe('active');
      expect(await entries('MEMBER_REACTIVATED', member.userId)).toHaveLength(1);
    });

    it('removes a suspended member, who can then no longer be reactivated', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
      expect((await memberOf(admin, member.userId)).status).toBe('removed');
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/reactivate`).expect(404);
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(404);
      const removed = await entries('MEMBER_REMOVED', member.userId);
      expect(removed).toHaveLength(1);
    });
  });

  describe('last sign-in', () => {
    it('is set by sign-up, sign-in and invitation accept, not by refresh, and shown to admins and the user only', async () => {
      const admin = await signUp(ctx);
      const me = await as(ctx, admin).get('/api/v1/auth/me').expect(200);
      const signedUpAt = me.body.user.lastSignInAt as string;
      expect(Date.parse(signedUpAt)).toBeGreaterThan(Date.now() - 60_000);

      await new Promise((resolve) => setTimeout(resolve, 15));
      const refreshed = await admin.agent.post('/api/v1/auth/refresh').expect(200);
      expect(refreshed.body.user.lastSignInAt).toBe(signedUpAt);
      const again = await agentFor(ctx)
        .post('/api/v1/auth/sign-in')
        .send({ email: admin.email, password: admin.password })
        .expect(200);
      expect(Date.parse(again.body.user.lastSignInAt)).toBeGreaterThan(Date.parse(signedUpAt));

      const member = await addMember(ctx, admin);
      const invited = await as(ctx, admin)
        .post('/api/v1/invitations')
        .send({ email: `joiner-${Date.now()}@example.test`, role: 'member' })
        .expect(201);
      const accepted = await agentFor(ctx)
        .post('/api/v1/invitations/accept')
        .send({
          token: tokenOf(invited.body.acceptUrl),
          displayName: 'Joiner',
          password: DEFAULT_PASSWORD,
        })
        .expect(201);
      expect(typeof accepted.body.user.lastSignInAt).toBe('string');

      const forAdmin = await as(ctx, admin).get('/api/v1/members').expect(200);
      expect((forAdmin.body as Listed[]).every((u) => 'lastSignInAt' in u)).toBe(true);
      await as(ctx, member).get('/api/v1/members').expect(403);
      const forMember = await as(ctx, member).get('/api/v1/people').expect(200);
      expect(forMember.body).toHaveLength(3);
      expect((forMember.body as Listed[]).some((u) => 'lastSignInAt' in u)).toBe(false);
      const ownMe = await as(ctx, member).get('/api/v1/auth/me').expect(200);
      expect(typeof ownMe.body.user.lastSignInAt).toBe('string');
    });
  });

  describe('inviting existing people', () => {
    it('allows a removed member of this tenant; refuses suspended (here), active and other tenants', async () => {
      const admin = await signUp(ctx);
      const other = await signUp(ctx);
      const suspendedHere = await addMember(ctx, admin);
      await as(ctx, admin).post(`/api/v1/members/${suspendedHere.userId}/suspend`).expect(200);
      const suspendedThere = await addMember(ctx, other);
      await as(ctx, other).post(`/api/v1/members/${suspendedThere.userId}/suspend`).expect(200);
      const removedThere = await addMember(ctx, other);
      await as(ctx, other).delete(`/api/v1/members/${removedThere.userId}`).expect(204);
      const active = await addMember(ctx, admin);
      const removedHere = await addMember(ctx, admin);
      await as(ctx, admin).delete(`/api/v1/members/${removedHere.userId}`).expect(204);

      const invite = (email: string) =>
        as(ctx, admin).post('/api/v1/invitations').send({ email, role: 'member' });
      expect((await invite(suspendedHere.email).expect(409)).body.code).toBe('MEMBER_SUSPENDED');
      expect((await invite(suspendedThere.email).expect(409)).body.code).toBe('EMAIL_TAKEN');
      expect((await invite(removedThere.email).expect(409)).body.code).toBe('EMAIL_TAKEN');
      expect((await invite(active.email).expect(409)).body.code).toBe('EMAIL_TAKEN');
      const ok = await invite(removedHere.email).expect(201);
      expect(ok.body).toMatchObject({ email: removedHere.email, status: 'pending' });
    });
  });

  describe('rejoining', () => {
    it('reactivates the same user with the new role, ends everything from before and clears personal data', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      const ws = await workspace(ctx, admin);
      await grantRootEdit(ctx, admin, member);
      const { id: recordId } = await createRecord(ctx, member, ws, { name: 'Their record' });
      const { id: adminRecord } = await createRecord(ctx, admin, ws, { name: 'Admin record' });
      await as(ctx, member).put(`/api/v1/records/${adminRecord}/favorite`).expect(204);
      await as(ctx, member).post(`/api/v1/records/${adminRecord}/views`).expect(204);
      await as(ctx, member)
        .post('/api/v1/saved-searches')
        .send({ name: 'Mine', criteria: { tags: ['x'] } })
        .expect(201);
      const comment = await as(ctx, member)
        .post(`/api/v1/records/${adminRecord}/comments`)
        .send({ body: 'Written before leaving' })
        .expect(201);
      await as(ctx, admin)
        .post(`/api/v1/records/${recordId}/comments`)
        .send({ body: 'Ping' })
        .expect(201);
      expect(
        (await as(ctx, member).get('/api/v1/notifications').expect(200)).body.items,
      ).toHaveLength(1);
      const oldCookie = member.agent;

      await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
      const invited = await as(ctx, admin)
        .post('/api/v1/invitations')
        .send({ email: member.email, role: 'admin' })
        .expect(201);
      const agent = agentFor(ctx);
      const accepted = await agent
        .post('/api/v1/invitations/accept')
        .send({
          token: tokenOf(invited.body.acceptUrl),
          displayName: 'Back Again',
          password: 'Rejoined!Passw0rd',
        })
        .expect(201);
      expect(accepted.body.user).toMatchObject({
        id: member.userId,
        email: member.email,
        role: 'admin',
        status: 'active',
        displayName: 'Back Again',
      });
      expect(typeof accepted.body.user.lastSignInAt).toBe('string');
      const fresh = { token: accepted.body.accessToken as string };

      await as(ctx, member).get('/api/v1/auth/me').expect(401);
      await oldCookie.post('/api/v1/auth/refresh').expect(401);
      await ctx
        .http()
        .post('/api/v1/auth/sign-in')
        .send({ email: member.email, password: DEFAULT_PASSWORD })
        .expect(401);
      await as(ctx, fresh).get('/api/v1/auth/me').expect(200);
      await agent.post('/api/v1/auth/refresh').expect(200);

      expect((await as(ctx, fresh).get('/api/v1/me/favorites').expect(200)).body).toEqual([]);
      expect((await as(ctx, fresh).get('/api/v1/me/recent').expect(200)).body).toEqual([]);
      expect((await as(ctx, fresh).get('/api/v1/saved-searches').expect(200)).body).toEqual([]);
      expect((await as(ctx, fresh).get('/api/v1/notifications').expect(200)).body.items).toEqual(
        [],
      );
      const comments = await as(ctx, fresh)
        .get(`/api/v1/records/${adminRecord}/comments`)
        .expect(200);
      const kept = comments.body as Array<{
        id: string;
        author: { id: string };
      }>;
      expect(kept.find((c) => c.id === comment.body.id)?.author.id).toBe(member.userId);

      const entry = await audit
        .findOne({ action: 'INVITATION_ACCEPTED', 'resource.id': invited.body.id })
        .lean();
      expect(entry?.context).toEqual({ role: 'admin', rejoined: true });
      const list = await as(ctx, admin).get('/api/v1/members').expect(200);
      expect((list.body as Listed[]).filter((u) => u.id === member.userId)).toHaveLength(1);
      const grants = await as(ctx, admin)
        .get(`/api/v1/access/grants?userId=${member.userId}`)
        .expect(200);
      expect(grants.body).toEqual([]);
    });

    it('lets only one of two racing rejoins win and rolls the other invitation back', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
      const first = await as(ctx, admin)
        .post('/api/v1/invitations')
        .send({ email: member.email, role: 'member' })
        .expect(201);

      const updateOne = users.updateOne.bind(users);
      let second: { id: string; status: number } | null = null;
      const spy = vi.spyOn(users, 'updateOne').mockImplementationOnce(async (...args) => {
        const invited = await as(ctx, admin)
          .post('/api/v1/invitations')
          .send({ email: member.email, role: 'admin' })
          .expect(201);
        const res = await ctx
          .http()
          .post('/api/v1/invitations/accept')
          .send({
            token: tokenOf(invited.body.acceptUrl),
            displayName: 'Second',
            password: 'Second!Passw0rd',
          });
        second = { id: invited.body.id as string, status: res.status };
        return updateOne(...args);
      });
      let outer: { status: number; body: { code?: string } };
      try {
        outer = await ctx
          .http()
          .post('/api/v1/invitations/accept')
          .send({
            token: tokenOf(first.body.acceptUrl),
            displayName: 'First',
            password: 'First!Passw0rd',
          });
      } finally {
        spy.mockRestore();
      }
      expect(second).toMatchObject({ status: 201 });
      expect(outer.status).toBe(409);
      expect(outer.body.code).toBe('EMAIL_TAKEN');

      const user = await users.findById(admin.tenantId, member.userId);
      expect(user).toMatchObject({ status: 'active', role: 'admin', displayName: 'Second' });
      expect(await users.count(admin.tenantId, { email: member.email })).toBe(1);
      expect((await invitations.findById(first.body.id).lean())?.acceptedAt).toBeNull();
      expect(
        await audit.countDocuments({ action: 'INVITATION_ACCEPTED', 'context.rejoined': true }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        await audit.countDocuments({
          action: 'INVITATION_ACCEPTED',
          'resource.id': { $in: [first.body.id, (second as unknown as { id: string }).id] },
        }),
      ).toBe(1);
      await signIn(ctx, member.email, 'Second!Passw0rd');
    });

    it('never ends the winning rejoin’s fresh session when the losing rejoin revokes late', async () => {
      const admin = await signUp(ctx);
      const member = await addMember(ctx, admin);
      await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
      const first = await as(ctx, admin)
        .post('/api/v1/invitations')
        .send({ email: member.email, role: 'member' })
        .expect(201);

      const sessions = ctx.app.get(RefreshTokensRepository, { strict: false });
      const revokeAll = sessions.revokeAllForUser.bind(sessions);
      const winner = agentFor(ctx);
      let winnerStatus = 0;
      const spy = vi.spyOn(sessions, 'revokeAllForUser').mockImplementationOnce(async (...args) => {
        const invited = await as(ctx, admin)
          .post('/api/v1/invitations')
          .send({ email: member.email, role: 'admin' })
          .expect(201);
        const res = await winner.post('/api/v1/invitations/accept').send({
          token: tokenOf(invited.body.acceptUrl),
          displayName: 'Winner',
          password: 'Winner!Passw0rd',
        });
        winnerStatus = res.status;
        return revokeAll(...args);
      });
      let loser: { status: number; body: { code?: string } };
      try {
        loser = await ctx
          .http()
          .post('/api/v1/invitations/accept')
          .send({
            token: tokenOf(first.body.acceptUrl),
            displayName: 'Loser',
            password: 'Loser!Passw0rd',
          });
      } finally {
        spy.mockRestore();
      }
      expect(winnerStatus).toBe(201);
      expect(loser.status).toBe(409);
      expect(loser.body.code).toBe('EMAIL_TAKEN');
      await winner.post('/api/v1/auth/refresh').expect(200);
    });
  });

  describe('races', () => {
    it('keeps an admin when two admins suspend each other', async () => {
      const first = await signUp(ctx, { tenantName: 'Suspend Each Other' });
      const second = await addMember(ctx, first, 'admin');
      const count = users.count.bind(users);
      let inner = 0;
      const spy = vi.spyOn(users, 'count').mockImplementationOnce(async (...args) => {
        const admins = await count(...args);
        inner = (await as(ctx, second).post(`/api/v1/members/${first.userId}/suspend`)).status;
        return admins;
      });
      let outer: { status: number; body: { code?: string } };
      try {
        outer = await as(ctx, first).post(`/api/v1/members/${second.userId}/suspend`);
      } finally {
        spy.mockRestore();
      }
      expect(inner).toBe(200);
      expect(outer.status).toBe(409);
      expect(outer.body.code).toBe('LAST_ADMIN');
      const [a, b] = await Promise.all(
        [first, second].map((u) => users.findById(first.tenantId, u.userId)),
      );
      expect(a).toMatchObject({ role: 'admin', status: 'suspended' });
      expect(b).toMatchObject({ role: 'admin', status: 'active' });
      await second.agent.post('/api/v1/auth/refresh').expect(200);
      expect(await entries('MEMBER_SUSPENDED', second.userId)).toHaveLength(0);
    });

    it('refuses a suspension when the admin being suspended was demoted meanwhile', async () => {
      const a = await signUp(ctx, { tenantName: 'Suspend vs demote' });
      const b = await addMember(ctx, a, 'admin');
      const c = await addMember(ctx, a, 'admin');
      const count = users.count.bind(users);
      const spy = vi.spyOn(users, 'count').mockImplementationOnce(async (...args) => {
        const admins = await count(...args);
        await as(ctx, c).patch(`/api/v1/members/${b.userId}`).send({ role: 'member' }).expect(200);
        return admins;
      });
      let res: { status: number; body: { code?: string } };
      try {
        res = await as(ctx, a).post(`/api/v1/members/${b.userId}/suspend`);
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MEMBER_CHANGED_CONCURRENTLY');
      expect(await users.findById(a.tenantId, b.userId)).toMatchObject({
        role: 'member',
        status: 'active',
      });
    });

    it('refuses a demotion when the admin was suspended meanwhile', async () => {
      const a = await signUp(ctx, { tenantName: 'Demote vs suspend' });
      const b = await addMember(ctx, a, 'admin');
      const c = await addMember(ctx, a, 'admin');
      const count = users.count.bind(users);
      const spy = vi.spyOn(users, 'count').mockImplementationOnce(async (...args) => {
        const admins = await count(...args);
        await as(ctx, c).post(`/api/v1/members/${b.userId}/suspend`).expect(200);
        return admins;
      });
      let res: { status: number; body: { code?: string } };
      try {
        res = await as(ctx, a).patch(`/api/v1/members/${b.userId}`).send({ role: 'member' });
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MEMBER_SUSPENDED');
      expect(await users.findById(a.tenantId, b.userId)).toMatchObject({
        role: 'admin',
        status: 'suspended',
      });
    });

    async function afterTargetRead(
      targetId: string,
      competing: () => Promise<unknown>,
      outer: () => Promise<{ status: number; body: { code?: string } }>,
    ) {
      const findById = users.findById.bind(users);
      let fired = false;
      const spy = vi.spyOn(users, 'findById').mockImplementation(async (...args) => {
        const read = await findById(...args);
        if (!fired && args[1] === targetId) {
          fired = true;
          await competing();
        }
        return read;
      });
      try {
        const res = await outer();
        expect(fired).toBe(true);
        return res;
      } finally {
        spy.mockRestore();
      }
    }

    it('does not reactivate a member who was removed meanwhile', async () => {
      const admin = await signUp(ctx);
      const other = await addMember(ctx, admin, 'admin');
      const member = await addMember(ctx, admin);
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      const res = await afterTargetRead(
        member.userId,
        () => as(ctx, other).delete(`/api/v1/members/${member.userId}`).expect(204),
        () => as(ctx, admin).post(`/api/v1/members/${member.userId}/reactivate`),
      );
      expect(res.status).toBe(404);
      expect((await users.findById(admin.tenantId, member.userId))?.status).toBe('removed');
      expect(await entries('MEMBER_REACTIVATED', member.userId)).toHaveLength(0);
    });

    it('does not remove a member who was reactivated meanwhile', async () => {
      const admin = await signUp(ctx);
      const other = await addMember(ctx, admin, 'admin');
      const member = await addMember(ctx, admin);
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      const res = await afterTargetRead(
        member.userId,
        () => as(ctx, other).post(`/api/v1/members/${member.userId}/reactivate`).expect(200),
        () => as(ctx, admin).delete(`/api/v1/members/${member.userId}`),
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MEMBER_CHANGED_CONCURRENTLY');
      expect((await users.findById(admin.tenantId, member.userId))?.status).toBe('active');
    });
  });
});
