import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { SECURITY_ACTIONS } from '../src/audit/audit-action.js';
import { AuditEntry } from '../src/audit/audit-entry.schema.js';
import { RefreshToken } from '../src/auth/refresh-token.schema.js';
import { Invitation } from '../src/members/invitation.schema.js';
import { addMember, as, signUp, uniqueEmail, type Actor } from './helpers/actors.js';
import { createRecord, workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const DAY = 86_400_000;

interface Entry {
  action: string;
  actor: { id: string } | null;
  context: Record<string, unknown>;
  createdAt: string;
}

function refreshCookieOf(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers['set-cookie'] as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith('mecm_refresh='));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie.split(';')[0];
}

describe('admin overview (e2e)', () => {
  let ctx: TestApp;
  let audit: Model<AuditEntry>;
  let admin: Actor;
  let member: Actor;
  let removed: Actor;
  let other: Actor;

  const overview = (actor: Actor) => as(ctx, actor).get('/api/v1/admin/overview');
  const failSignIn = (email: string, password: string) =>
    ctx.http().post('/api/v1/auth/sign-in').send({ email, password }).expect(401);

  beforeAll(async () => {
    ctx = await createTestApp();
    audit = ctx.app.get(getModelToken(AuditEntry.name));
    const invitations = ctx.app.get<Model<Invitation>>(getModelToken(Invitation.name));
    const refreshTokens = ctx.app.get<Model<RefreshToken>>(getModelToken(RefreshToken.name));

    admin = await signUp(ctx, { tenantName: 'Overview Co' });
    member = await addMember(ctx, admin);
    await addMember(ctx, admin, 'admin');
    removed = await addMember(ctx, admin);
    await as(ctx, admin).delete(`/api/v1/members/${removed.userId}`).expect(204);

    await as(ctx, admin)
      .post('/api/v1/invitations')
      .send({ email: uniqueEmail('pending'), role: 'member' })
      .expect(201);
    const revoked = await as(ctx, admin)
      .post('/api/v1/invitations')
      .send({ email: uniqueEmail('revoked'), role: 'member' })
      .expect(201);
    await as(ctx, admin).delete(`/api/v1/invitations/${revoked.body.id}`).expect(204);
    const expired = await as(ctx, admin)
      .post('/api/v1/invitations')
      .send({ email: uniqueEmail('expired'), role: 'member' })
      .expect(201);
    await invitations.updateOne(
      { _id: new Types.ObjectId(expired.body.id) },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const ws = await workspace(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    await createRecord(ctx, admin, ws, { name: 'A', file: { content: '12345', name: 'a.txt' } });
    await createRecord(ctx, member, ws, {
      name: 'B',
      file: { content: '1234567890', name: 'b.txt' },
    });
    const trashed = await createRecord(ctx, admin, ws, { name: 'Trashed' });
    await as(ctx, admin).delete(`/api/v1/records/${trashed.id}`).expect(204);
    const purged = await createRecord(ctx, admin, ws, { name: 'Purged' });
    await as(ctx, admin).delete(`/api/v1/records/${purged.id}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/trash/records/${purged.id}`).expect(200);
    const old = await as(ctx, admin)
      .post('/api/v1/folders')
      .send({ name: 'Old', parentId: ws.rootId })
      .expect(201);
    await as(ctx, admin).delete(`/api/v1/folders/${old.body.id}`).expect(204);
    const draft = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ name: 'Draft', fields: [{ key: 'x', label: 'X', type: 'text' }] })
      .expect(201);
    await as(ctx, admin).post(`/api/v1/content-types/${draft.body.id}/archive`).expect(200);

    await failSignIn(member.email, 'wrong-password');
    await failSignIn(removed.email, removed.password);
    const first = await member.agent.post('/api/v1/auth/refresh').expect(200);
    const stale = refreshCookieOf(first);
    await member.agent.post('/api/v1/auth/refresh').expect(200);
    await refreshTokens.updateMany(
      { userId: new Types.ObjectId(member.userId), rotatedAt: { $ne: null } },
      { rotatedAt: new Date(Date.now() - 60_000) },
    );
    await ctx.http().post('/api/v1/auth/refresh').set('Cookie', stale).expect(401);

    const backdated = new Date(Date.now() - 10 * DAY);
    await audit.collection.insertMany(
      ['RECORD_CREATED', 'SIGN_IN_FAILED'].map((action) => ({
        tenantId: new Types.ObjectId(admin.tenantId),
        action,
        actor: null,
        resource: null,
        context: {},
        createdAt: backdated,
      })),
    );

    other = await signUp(ctx, { tenantName: 'Other Co' });
    const theirs = await workspace(ctx, other);
    await createRecord(ctx, other, theirs, { name: 'Theirs', file: { content: 'x', name: 'x' } });
    await failSignIn(other.email, 'wrong-password');
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('counts the tenant from its collections and audit log', async () => {
    const before = Date.now();
    const res = await overview(admin).expect(200);
    const { security, generatedAt, ...counts } = res.body;
    expect(new Date(generatedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(counts).toEqual({
      members: { active: 3, suspended: 0, removed: 1, activeAdmins: 2 },
      invitations: { pending: 1 },
      records: { live: 2, trashed: 1, createdLast7Days: 4, createdLast30Days: 5 },
      folders: { live: 1, trashed: 1 },
      contentTypes: { active: 1, archived: 1 },
      storage: { bytes: 15, files: 2 },
    });
    expect(security.last7Days).toEqual({ signInFailed: 2, accessDenied: 0, tokenReuse: 1 });
  });

  it('lists the latest security events only, newest first, with the failure reason', async () => {
    const res = await overview(admin).expect(200);
    const recent = res.body.security.recent as Entry[];
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThanOrEqual(10);
    expect(recent.every((e) => (SECURITY_ACTIONS as readonly string[]).includes(e.action))).toBe(
      true,
    );
    const times = recent.map((e) => e.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(recent.map((e) => e.action)).toEqual(
      expect.arrayContaining(['MEMBER_REMOVED', 'SIGN_IN_FAILED', 'TOKEN_REUSE_DETECTED']),
    );
    const reasons = recent
      .filter((e) => e.action === 'SIGN_IN_FAILED' && e.actor)
      .map((e) => String(e.context.reason))
      .sort((a, b) => a.localeCompare(b));
    expect(reasons).toEqual(['credentials', 'inactive']);
  });

  it('refuses members with 403 and audits the attempt', async () => {
    const res = await overview(member).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    const denied = await audit
      .findOne({ action: 'ACCESS_DENIED', 'actor.id': new Types.ObjectId(member.userId) })
      .lean();
    expect(denied?.context).toMatchObject({ attemptedAction: 'admin.overview', role: 'member' });
    const after = await overview(admin).expect(200);
    expect(after.body.security.last7Days.accessDenied).toBe(1);
    expect((after.body.security.recent as Entry[])[0]).toMatchObject({
      action: 'ACCESS_DENIED',
      actor: { id: member.userId },
    });
  });

  it('counts only the caller’s tenant', async () => {
    const res = await overview(other).expect(200);
    expect(res.body).toMatchObject({
      members: { active: 1, suspended: 0, removed: 0, activeAdmins: 1 },
      invitations: { pending: 0 },
      records: { live: 1, trashed: 0, createdLast7Days: 1, createdLast30Days: 1 },
      folders: { live: 1, trashed: 0 },
      contentTypes: { active: 1, archived: 0 },
      storage: { bytes: 1, files: 1 },
      security: { last7Days: { signInFailed: 1, accessDenied: 0, tokenReuse: 0 } },
    });
    const recent = res.body.security.recent as Entry[];
    expect(recent.map((e) => e.action)).toEqual(['SIGN_IN_FAILED']);
    expect(recent[0].actor?.id).toBe(other.userId);
  });

  it('requires authentication', async () => {
    await ctx.http().get('/api/v1/admin/overview').expect(401);
  });

  it('serves the security events page from GET /audit?actions=', async () => {
    const res = await as(ctx, admin)
      .get(`/api/v1/audit?actions=${SECURITY_ACTIONS.join(',')}&pageSize=100`)
      .expect(200);
    const actions = new Set((res.body.items as Entry[]).map((e) => e.action));
    expect([...actions].every((a) => (SECURITY_ACTIONS as readonly string[]).includes(a))).toBe(
      true,
    );
    expect(actions.has('SIGN_IN_FAILED')).toBe(true);
  });

  it('shows why a sign-in failed to admins only', async () => {
    const adminView = await as(ctx, admin)
      .get(`/api/v1/audit?action=SIGN_IN_FAILED&actorId=${member.userId}`)
      .expect(200);
    expect(adminView.body.items[0].context).toMatchObject({ reason: 'credentials' });

    await as(ctx, member).get('/api/v1/audit?action=SIGN_IN_FAILED').expect(403);

    const dashboard = await as(ctx, member).get('/api/v1/dashboard').expect(200);
    const failed = (dashboard.body.recentActivity as Entry[]).filter(
      (e) => e.action === 'SIGN_IN_FAILED',
    );
    expect(failed.length).toBe(1);
    expect(failed[0].context).not.toHaveProperty('reason');
  });
});
