import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { AuditAction } from '../src/audit/audit-action.js';
import { AuditEntry } from '../src/audit/audit-entry.schema.js';
import { Invitation } from '../src/members/invitation.schema.js';
import { UsersRepository } from '../src/users/users.repository.js';
import {
  addMember,
  agentFor,
  as,
  signIn,
  signUp,
  uniqueEmail,
  type Actor,
} from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

function tokenOf(acceptUrl: string): string {
  return new URL(acceptUrl).searchParams.get('token') as string;
}

describe('members and invitations (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let other: Actor;
  let invitations: Model<Invitation>;
  let audit: Model<AuditEntry>;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'People Co', displayName: 'Admin One' });
    other = await signUp(ctx, { tenantName: 'Other Co' });
    invitations = ctx.app.get(getModelToken(Invitation.name));
    audit = ctx.app.get(getModelToken(AuditEntry.name));
  });

  afterAll(async () => {
    await ctx.stop();
  });

  async function invite(email: string, role: 'admin' | 'member' = 'member') {
    return as(ctx, admin).post('/api/v1/invitations').send({ email, role }).expect(201);
  }

  it('invites by email, shows the link once, stores only a hash and lets the invitee join with the invited role', async () => {
    const email = uniqueEmail('invitee');
    const created = await invite(email.toUpperCase());
    expect(created.body).toMatchObject({
      email,
      role: 'member',
      status: 'pending',
      invitedBy: { id: admin.userId },
    });
    const token = tokenOf(created.body.acceptUrl);
    expect(token.length).toBeGreaterThanOrEqual(40);
    const stored = await invitations.findById(created.body.id).lean();
    expect(JSON.stringify(stored)).not.toContain(token);
    const list = await as(ctx, admin).get('/api/v1/invitations').expect(200);
    expect(list.body.find((i: { id: string }) => i.id === created.body.id).acceptUrl).toBeNull();

    const preview = await ctx.http().get(`/api/v1/invitations/preview?token=${token}`).expect(200);
    expect(preview.body).toMatchObject({
      tenantName: 'People Co',
      email,
      role: 'member',
      status: 'pending',
    });

    const agent = agentFor(ctx);
    const accepted = await agent
      .post('/api/v1/invitations/accept')
      .send({ token, displayName: 'New Member', password: 'Member!Passw0rd' })
      .expect(201);
    expect(accepted.body.user).toMatchObject({ email, role: 'member' });
    expect(accepted.body.tenant.id).toBe(admin.tenantId);
    await agent.post('/api/v1/auth/refresh').expect(200);
    await signIn(ctx, email, 'Member!Passw0rd');

    const again = await agentFor(ctx)
      .post('/api/v1/invitations/accept')
      .send({ token, displayName: 'Twice', password: 'Member!Passw0rd' })
      .expect(409);
    expect(again.body.code).toBe('INVITATION_NOT_PENDING');
    expect(
      await audit.countDocuments({
        action: { $in: ['INVITATION_CREATED', 'INVITATION_ACCEPTED'] },
        'resource.label': email,
      }),
    ).toBe(2);
    expect(JSON.stringify(await audit.find({ 'resource.label': email }).lean())).not.toContain(
      token,
    );
  });

  it('rejects inviting an email that already has an account, in any tenant', async () => {
    const res = await as(ctx, admin)
      .post('/api/v1/invitations')
      .send({ email: other.email, role: 'member' })
      .expect(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
  });

  it('rejects unknown, expired and revoked tokens and replaces an earlier pending invitation', async () => {
    await ctx
      .http()
      .get(`/api/v1/invitations/preview?token=${'x'.repeat(43)}`)
      .expect(404);
    const email = uniqueEmail('late');
    const first = await invite(email);
    const second = await invite(email, 'admin');
    const list = await as(ctx, admin).get('/api/v1/invitations').expect(200);
    expect(list.body.find((i: { id: string }) => i.id === first.body.id).status).toBe('revoked');
    const revoked = await ctx
      .http()
      .post('/api/v1/invitations/accept')
      .send({ token: tokenOf(first.body.acceptUrl), displayName: 'X', password: 'Passw0rd!long' })
      .expect(409);
    expect(revoked.body.message).toBe('This invitation is revoked');

    await invitations
      .updateOne({ _id: second.body.id }, { expiresAt: new Date(Date.now() - 1000) })
      .exec();
    const expired = await ctx
      .http()
      .post('/api/v1/invitations/accept')
      .send({ token: tokenOf(second.body.acceptUrl), displayName: 'X', password: 'Passw0rd!long' })
      .expect(409);
    expect(expired.body.message).toBe('This invitation is expired');

    const third = await invite(email);
    await as(ctx, admin).delete(`/api/v1/invitations/${third.body.id}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/invitations/${third.body.id}`).expect(409);
  });

  it('changes roles immediately, protects the last admin and removes members', async () => {
    const member = await addMember(ctx, admin);
    await as(ctx, member).get('/api/v1/invitations').expect(403);
    await as(ctx, member)
      .post('/api/v1/invitations')
      .send({ email: uniqueEmail(), role: 'member' })
      .expect(403);
    await as(ctx, member)
      .patch(`/api/v1/members/${admin.userId}`)
      .send({ role: 'member' })
      .expect(403);

    const lastAdmin = await as(ctx, admin)
      .patch(`/api/v1/members/${admin.userId}`)
      .send({ role: 'member' })
      .expect(409);
    expect(lastAdmin.body.code).toBe('LAST_ADMIN');
    const promoted = await as(ctx, admin)
      .patch(`/api/v1/members/${member.userId}`)
      .send({ role: 'admin' })
      .expect(200);
    expect(promoted.body.role).toBe('admin');
    await as(ctx, member).get('/api/v1/invitations').expect(200);
    await as(ctx, admin)
      .patch(`/api/v1/members/${member.userId}`)
      .send({ role: 'member' })
      .expect(200);
    await as(ctx, member).get('/api/v1/invitations').expect(403);

    const self = await as(ctx, admin).delete(`/api/v1/members/${admin.userId}`).expect(400);
    expect(self.body.code).toBe('CANNOT_REMOVE_SELF');
    await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
    await as(ctx, member).get('/api/v1/auth/me').expect(401);
    await member.agent.post('/api/v1/auth/refresh').expect(401);
    await ctx
      .http()
      .post('/api/v1/auth/sign-in')
      .send({ email: member.email, password: member.password })
      .expect(401);
    const list = await as(ctx, admin).get('/api/v1/members').expect(200);
    expect(list.body.find((u: { id: string }) => u.id === member.userId).status).toBe('removed');
    const actions = (
      await as(ctx, admin).get('/api/v1/audit?resourceType=user').expect(200)
    ).body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED']));
  });

  it('keeps an admin when two admins demote or remove each other concurrently', async () => {
    const cases = [
      {
        name: 'demote',
        send: (a: Actor, id: string) =>
          as(ctx, a).patch(`/api/v1/members/${id}`).send({ role: 'member' }),
      },
      {
        name: 'remove',
        send: (a: Actor, id: string) => as(ctx, a).delete(`/api/v1/members/${id}`),
      },
    ];
    for (const { name, send } of cases) {
      const first = await signUp(ctx, { tenantName: `Two Admins ${name}` });
      const second = await addMember(ctx, first, 'admin');
      const users = ctx.app.get(UsersRepository, { strict: false });
      const count = users.count.bind(users);
      let inner = 0;
      const spy = vi.spyOn(users, 'count').mockImplementationOnce(async (...args) => {
        const admins = await count(...args);
        inner = (await send(second, first.userId)).status;
        return admins;
      });
      let outer: { status: number; body: { code?: string } };
      try {
        outer = await send(first, second.userId);
      } finally {
        spy.mockRestore();
      }
      expect(inner).toBeLessThan(300);
      expect(outer.status).toBe(409);
      expect(outer.body.code).toBe('LAST_ADMIN');
      const list = await as(ctx, second).get('/api/v1/members').expect(200);
      const admins = list.body.filter(
        (u: { role: string; status: string }) => u.role === 'admin' && u.status === 'active',
      );
      expect(admins.map((u: { id: string }) => u.id)).toEqual([second.userId]);

      const third = await signUp(ctx, { tenantName: `Parallel Admins ${name}` });
      const fourth = await addMember(ctx, third, 'admin');
      const results = await Promise.all([send(third, fourth.userId), send(fourth, third.userId)]);
      expect(results.filter((r) => r.status < 300).length).toBeLessThanOrEqual(1);
      const [one, two] = await Promise.all(
        [third, fourth].map((a) =>
          ctx.app.get(UsersRepository, { strict: false }).findById(third.tenantId, a.userId),
        ),
      );
      expect(
        [one, two].filter((u) => u?.role === 'admin' && u.status === 'active').length,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('does not remove a member who became the only admin after the removal read them', async () => {
    const b = await signUp(ctx, { tenantName: 'Promoted Meanwhile' });
    const a = await addMember(ctx, b);
    const users = ctx.app.get(UsersRepository, { strict: false });
    const findById = users.findById.bind(users);
    let fired = false;
    const spy = vi.spyOn(users, 'findById').mockImplementation(async (...args) => {
      const read = await findById(...args);
      if (!fired && args[1] === a.userId) {
        fired = true;
        await as(ctx, b).patch(`/api/v1/members/${a.userId}`).send({ role: 'admin' }).expect(200);
        await as(ctx, a).patch(`/api/v1/members/${b.userId}`).send({ role: 'member' }).expect(200);
      }
      return read;
    });
    let removal: { status: number; body: { code?: string } };
    try {
      removal = await as(ctx, b).delete(`/api/v1/members/${a.userId}`);
    } finally {
      spy.mockRestore();
    }
    expect(fired).toBe(true);
    expect(removal.status).toBe(409);
    expect(removal.body.code).toBe('MEMBER_CHANGED_CONCURRENTLY');
    const [nowA, nowB] = await Promise.all([a, b].map((u) => users.findById(b.tenantId, u.userId)));
    expect(nowA).toMatchObject({ role: 'admin', status: 'active' });
    expect(nowB).toMatchObject({ role: 'member', status: 'active' });
  });

  describe('an accept racing a revoke', () => {
    function beforeNextInvitationWrite(meanwhile: () => Promise<void>) {
      const findOneAndUpdate = invitations.findOneAndUpdate.bind(invitations);
      return vi.spyOn(invitations, 'findOneAndUpdate').mockImplementationOnce((...args) => {
        const query = findOneAndUpdate(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          await meanwhile();
          return exec();
        };
        return query;
      });
    }

    const auditCount = (action: AuditAction, id: string) =>
      audit.countDocuments({ action, 'resource.id': id });

    it('refuses the accept when the revoke lands between its read and its claim, and creates no user', async () => {
      const email = uniqueEmail('revoked-meanwhile');
      const created = await invite(email);
      const spy = beforeNextInvitationWrite(async () => {
        await as(ctx, admin).delete(`/api/v1/invitations/${created.body.id}`).expect(204);
      });
      let res: { status: number; body: { code?: string; message?: string } };
      try {
        res = await ctx
          .http()
          .post('/api/v1/invitations/accept')
          .send({
            token: tokenOf(created.body.acceptUrl),
            displayName: 'Late',
            password: 'Late!Passw0rd',
          });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'INVITATION_NOT_PENDING',
        message: 'This invitation is no longer pending',
      });
      expect(await ctx.app.get(UsersRepository).findByEmailAcrossTenants(email)).toBeNull();
      const stored = await invitations.findById(created.body.id).lean();
      expect(stored?.acceptedAt).toBeNull();
      expect(stored?.revokedAt).not.toBeNull();
      expect(await auditCount('INVITATION_ACCEPTED', created.body.id)).toBe(0);
      expect(await auditCount('INVITATION_REVOKED', created.body.id)).toBe(1);
    });

    it('refuses the revoke when the accept lands between its read and its write, and keeps the invitation accepted', async () => {
      const email = uniqueEmail('accepted-meanwhile');
      const created = await invite(email);
      let accepted = 0;
      const spy = beforeNextInvitationWrite(async () => {
        const res = await ctx
          .http()
          .post('/api/v1/invitations/accept')
          .send({
            token: tokenOf(created.body.acceptUrl),
            displayName: 'Quick',
            password: 'Quick!Passw0rd',
          });
        accepted = res.status;
      });
      let res: { status: number; body: { code?: string; message?: string } };
      try {
        res = await as(ctx, admin).delete(`/api/v1/invitations/${created.body.id}`);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(accepted).toBe(201);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'INVITATION_NOT_PENDING',
        message: 'This invitation is accepted',
      });
      expect(await ctx.app.get(UsersRepository).findByEmailAcrossTenants(email)).toMatchObject({
        status: 'active',
      });
      const list = await as(ctx, admin).get('/api/v1/invitations').expect(200);
      expect(list.body.find((i: { id: string }) => i.id === created.body.id).status).toBe(
        'accepted',
      );
      expect((await invitations.findById(created.body.id).lean())?.revokedAt).toBeNull();
      expect(await auditCount('INVITATION_ACCEPTED', created.body.id)).toBe(1);
      expect(await auditCount('INVITATION_REVOKED', created.body.id)).toBe(0);
      await signIn(ctx, email, 'Quick!Passw0rd');
    });
  });

  it('isolates members and invitations between tenants', async () => {
    const pending = await invite(uniqueEmail('iso'));
    const others = await as(ctx, other).get('/api/v1/members').expect(200);
    expect(others.body.map((u: { id: string }) => u.id)).toEqual([other.userId]);
    expect((await as(ctx, other).get('/api/v1/invitations').expect(200)).body).toEqual([]);
    await as(ctx, other).delete(`/api/v1/invitations/${pending.body.id}`).expect(404);
    await as(ctx, other)
      .patch(`/api/v1/members/${admin.userId}`)
      .send({ role: 'member' })
      .expect(404);
    await as(ctx, other).delete(`/api/v1/members/${admin.userId}`).expect(404);
  });
});

describe('audit visibility (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('shows admins every entry and members none (the audit page is admin-only), with no way to change entries', async () => {
    const admin = await signUp(ctx, { tenantName: 'Audit Co' });
    const member = await addMember(ctx, admin);
    await as(ctx, admin).post('/api/v1/content-types').send({ name: 'T', fields: [] }).expect(201);
    await as(ctx, member).post('/api/v1/content-types').send({ name: 'U', fields: [] }).expect(403);
    const all = await as(ctx, admin).get('/api/v1/audit?pageSize=100').expect(200);
    expect(all.body.scope).toBe('tenant');
    expect(new Set(all.body.items.map((e: { actor: { id: string } }) => e.actor?.id))).toEqual(
      new Set([admin.userId, member.userId]),
    );
    await as(ctx, member).get(`/api/v1/audit?pageSize=100&actorId=${admin.userId}`).expect(403);
    await as(ctx, member).get('/api/v1/audit/actions').expect(403);
    const denied = await as(ctx, admin)
      .get(`/api/v1/audit?action=ACCESS_DENIED&actorId=${member.userId}&pageSize=100`)
      .expect(200);
    expect(
      denied.body.items.map(
        (e: { context: { attemptedAction: string } }) => e.context.attemptedAction,
      ),
    ).toEqual(expect.arrayContaining(['audit.read']));
    await as(ctx, admin).delete('/api/v1/audit').expect(404);
    await as(ctx, admin).patch('/api/v1/audit').send({}).expect(404);
    const other = await signUp(ctx, { tenantName: 'Else' });
    const theirs = await as(ctx, other).get('/api/v1/audit?pageSize=100').expect(200);
    expect(
      theirs.body.items.every((e: { actor: { id: string } }) => e.actor.id === other.userId),
    ).toBe(true);
  });
});
