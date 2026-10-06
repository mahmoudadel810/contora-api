import { addMember, as, signIn, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('dashboard (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Dash Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('summarises counts, storage, my check-outs, recent records and activity', async () => {
    const a = await createRecord(ctx, admin, ws, {
      name: 'Alpha',
      file: { content: '12345', name: 'a.txt' },
    });
    await as(ctx, admin)
      .post(`/api/v1/records/${a.id}/versions`)
      .attach('file', Buffer.from('12345'), 'a2.txt')
      .expect(201);
    const b = await createRecord(ctx, member, ws, {
      name: 'Beta',
      file: { content: '1234567890', name: 'b.txt' },
    });
    const trashed = await createRecord(ctx, admin, ws, { name: 'Gone' });
    await as(ctx, admin).delete(`/api/v1/records/${trashed.id}`).expect(204);
    await as(ctx, member).post(`/api/v1/records/${b.id}/checkout`).expect(200);

    const mine = await as(ctx, member).get('/api/v1/dashboard').expect(200);
    expect(mine.body.counts).toEqual({
      records: 2,
      versions: null,
      folders: 1,
      contentTypes: 1,
      members: null,
      trashed: null,
    });
    expect(mine.body.storage).toBeNull();
    expect(mine.body.myCheckouts.map((r: { name: string }) => r.name)).toEqual(['Beta']);
    expect(mine.body.recentRecords[0].name).toBe('Beta');
    expect(mine.body.activityScope).toBe('own');
    expect(
      mine.body.recentActivity.every(
        (e: { actor: { id: string } }) => e.actor.id === member.userId,
      ),
    ).toBe(true);

    const adminView = await as(ctx, admin).get('/api/v1/dashboard').expect(200);
    expect(adminView.body.counts).toEqual({
      records: 2,
      versions: 4,
      folders: 1,
      contentTypes: 1,
      members: 2,
      trashed: 1,
    });
    expect(adminView.body.storage).toEqual({ storedBytes: 15, storedFiles: 2, versionBytes: 20 });
    expect(adminView.body.myCheckouts).toEqual([]);
    expect(adminView.body.activityScope).toBe('tenant');
    expect(
      new Set(adminView.body.recentActivity.map((e: { actor: { id: string } }) => e.actor.id)).size,
    ).toBe(2);
  });

  it('leaves sign-ins and sign-outs out of recent activity', async () => {
    const again = await signIn(ctx, member.email, member.password);
    await again.agent.post('/api/v1/auth/sign-out').expect(204);
    const log = await as(ctx, admin)
      .get(`/api/v1/audit?actions=SIGN_IN,SIGN_OUT&actorId=${member.userId}`)
      .expect(200);
    expect(log.body.total).toBeGreaterThanOrEqual(3);
    for (const actor of [member, admin]) {
      const res = await as(ctx, actor).get('/api/v1/dashboard').expect(200);
      const actions = res.body.recentActivity.map((e: { action: string }) => e.action);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions).not.toContain('SIGN_IN');
      expect(actions).not.toContain('SIGN_OUT');
    }
  });

  it('is tenant-isolated and requires authentication', async () => {
    await ctx.http().get('/api/v1/dashboard').expect(401);
    const theirs = await as(ctx, other).get('/api/v1/dashboard').expect(200);
    expect(theirs.body.counts).toEqual({
      records: 0,
      versions: 0,
      folders: 0,
      contentTypes: 0,
      members: 1,
      trashed: 0,
    });
    expect(theirs.body.storage.storedBytes).toBe(0);
    expect(theirs.body.recentRecords).toEqual([]);
    expect(
      theirs.body.recentActivity.every(
        (e: { actor: { id: string } }) => e.actor.id === other.userId,
      ),
    ).toBe(true);
  });
});
