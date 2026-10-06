import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { Notification } from '../src/notifications/notification.schema.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface Item {
  id: string;
  kind: string;
  title: string;
  recordId: string | null;
  read: boolean;
}

describe('notifications (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;

  const inbox = async (actor: Actor): Promise<{ items: Item[]; unread: number }> =>
    (await as(ctx, actor).get('/api/v1/notifications').expect(200)).body;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Inbox Co', displayName: 'Ada Admin' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  beforeEach(async () => {
    await as(ctx, admin).post('/api/v1/notifications/read-all').expect(204);
    await as(ctx, member).post('/api/v1/notifications/read-all').expect(204);
  });

  it('tells the creator and followers about comments, but never the commenter', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Discussed' });
    const third = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, third);
    await as(ctx, third).put(`/api/v1/records/${id}/favorite`).expect(204);
    await as(ctx, member)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'Please check the totals' })
      .expect(201);

    const adminInbox = await inbox(admin);
    expect(adminInbox.unread).toBe(1);
    expect(adminInbox.items[0]).toMatchObject({
      kind: 'COMMENT_ON_RECORD',
      title: 'Test member commented on "Discussed"',
      body: 'Please check the totals',
      recordId: id,
      read: false,
    });
    expect((await inbox(third)).items[0]).toMatchObject({ kind: 'COMMENT_ON_RECORD' });
    expect((await inbox(member)).unread).toBe(0);
  });

  it('does not notify people who have left the tenant', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Left behind' });
    const leaver = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, leaver);
    await as(ctx, leaver).put(`/api/v1/records/${id}/favorite`).expect(204);
    await as(ctx, admin).delete(`/api/v1/members/${leaver.userId}`).expect(204);
    await as(ctx, admin)
      .post(`/api/v1/records/${id}/versions`)
      .send({ metadata: { supplier: 'Later', amount: 3 } })
      .expect(201);
    const model = ctx.app.get<Model<Notification>>(getModelToken(Notification.name));
    expect(await model.countDocuments({ userId: new Types.ObjectId(leaver.userId) })).toBe(0);
  });

  it('tells followers about new and restored versions', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Followed' });
    await as(ctx, member).put(`/api/v1/records/${id}/favorite`).expect(204);
    await as(ctx, admin)
      .post(`/api/v1/records/${id}/versions`)
      .send({ metadata: { supplier: 'New', amount: 2 } })
      .expect(201);
    await as(ctx, admin).post(`/api/v1/records/${id}/versions/1/restore`).send({}).expect(201);
    const titles = (await inbox(member)).items.slice(0, 2).map((n) => n.title);
    expect(titles).toEqual([
      '"Followed" has a new version (v3)',
      '"Followed" has a new version (v2)',
    ]);
    expect((await inbox(admin)).unread).toBe(0);
  });

  it('tells the holder when an admin force-releases their check-out, and members about role changes', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Held' });
    await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
    await as(ctx, admin).post(`/api/v1/records/${id}/force-release`).expect(200);
    const colleague = await addMember(ctx, admin);
    await as(ctx, admin)
      .patch(`/api/v1/members/${colleague.userId}`)
      .send({ role: 'admin' })
      .expect(200);

    expect((await inbox(member)).items[0]).toMatchObject({
      kind: 'CHECKOUT_FORCE_RELEASED',
      title: 'Ada Admin released your check-out of "Held"',
      recordId: id,
    });
    expect((await inbox(colleague)).items[0]).toMatchObject({
      kind: 'ROLE_CHANGED',
      title: 'Ada Admin changed your role to admin',
    });
  });

  it('marks one or all as read, idempotently, even in parallel', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Busy' });
    for (const body of ['one', 'two', 'three']) {
      await as(ctx, member).post(`/api/v1/records/${id}/comments`).send({ body }).expect(201);
    }
    const before = await inbox(admin);
    expect(before.unread).toBe(3);
    const first = before.items[0].id;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => as(ctx, admin).post(`/api/v1/notifications/${first}/read`)),
    );
    expect(results.map((r) => r.status)).toEqual([204, 204, 204, 204]);
    const count = await as(ctx, admin).get('/api/v1/notifications/unread-count').expect(200);
    expect(count.body).toEqual({ unread: 2 });
    const unreadOnly = await as(ctx, admin).get('/api/v1/notifications?unread=true').expect(200);
    expect(unreadOnly.body.items.map((n: Item) => n.id)).not.toContain(first);

    await Promise.all([
      as(ctx, admin).post('/api/v1/notifications/read-all').expect(204),
      as(ctx, admin).post('/api/v1/notifications/read-all').expect(204),
    ]);
    expect((await inbox(admin)).unread).toBe(0);
    await as(ctx, member).post(`/api/v1/notifications/${first}/read`).expect(404);
    await as(ctx, admin).post('/api/v1/notifications/nope/read').expect(404);
  });

  it('validates the unread filter', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Filtered' });
    await as(ctx, member).post(`/api/v1/records/${id}/comments`).send({ body: 'x' }).expect(201);
    await as(ctx, admin).post('/api/v1/notifications/read-all').expect(204);
    await as(ctx, member).post(`/api/v1/records/${id}/comments`).send({ body: 'y' }).expect(201);

    const all = await as(ctx, admin).get('/api/v1/notifications?unread=false').expect(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);
    const unread = await as(ctx, admin).get('/api/v1/notifications?unread=true').expect(200);
    expect(unread.body.items).toHaveLength(1);

    for (const query of ['unread=maybe', 'unread=1', 'unread=true&unread=true', 'page=2']) {
      const res = await as(ctx, admin).get(`/api/v1/notifications?${query}`).expect(400);
      expect(res.body.code, query).toBe('VALIDATION_FAILED');
    }
  });

  it('removes notifications about purged records', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Short-lived' });
    await as(ctx, member).post(`/api/v1/records/${id}/comments`).send({ body: 'x' }).expect(201);
    expect((await inbox(admin)).items.some((n) => n.recordId === id)).toBe(true);
    await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/trash/records/${id}`).expect(200);
    expect((await inbox(admin)).items.some((n) => n.recordId === id)).toBe(false);
  });

  it('isolates notifications between tenants', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Private talk' });
    await as(ctx, member)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'secret' })
      .expect(201);
    const target = (await inbox(admin)).items[0].id;
    expect((await inbox(other)).items).toEqual([]);
    await as(ctx, other).post(`/api/v1/notifications/${target}/read`).expect(404);
    await as(ctx, other).post('/api/v1/notifications/read-all').expect(204);
    expect((await inbox(admin)).items[0]).toMatchObject({ id: target, read: false });
    await ctx.http().get('/api/v1/notifications').expect(401);
    await ctx.http().get('/api/v1/notifications/unread-count').expect(401);
  });

  it('counts unread notifications per tenant, and another tenant never changes the count', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Counted' });
    await as(ctx, member).post(`/api/v1/records/${id}/comments`).send({ body: 'one' }).expect(201);
    await as(ctx, member).post(`/api/v1/records/${id}/comments`).send({ body: 'two' }).expect(201);
    const count = async (actor: Actor) =>
      (await as(ctx, actor).get('/api/v1/notifications/unread-count').expect(200)).body;
    expect(await count(admin)).toEqual({ unread: 2 });

    const otherMember = await addMember(ctx, other);
    await grantRootEdit(ctx, other, otherMember);
    const otherWs = await workspace(ctx, other, 'Other inbox');
    const theirs = await createRecord(ctx, other, otherWs, { name: 'Theirs' });
    await as(ctx, otherMember)
      .post(`/api/v1/records/${theirs.id}/comments`)
      .send({ body: 'hello' })
      .expect(201);
    expect(await count(other)).toEqual({ unread: 1 });
    expect(await count(admin)).toEqual({ unread: 2 });

    await as(ctx, other).post('/api/v1/notifications/read-all').expect(204);
    expect(await count(other)).toEqual({ unread: 0 });
    expect(await count(admin)).toEqual({ unread: 2 });
  });
});
