import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RecordComment } from '../src/comments/comment.schema.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('comments (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Talk Co', displayName: 'Ada Admin' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('adds and lists comments in order, even while someone else holds the check-out', async () => {
    const { id } = await createRecord(ctx, admin, ws);
    await as(ctx, admin).post(`/api/v1/records/${id}/checkout`).expect(200);
    const first = await as(ctx, member)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: '  Please check the amount  ' })
      .expect(201);
    expect(first.body).toMatchObject({
      body: 'Please check the amount',
      author: { id: member.userId },
    });
    await as(ctx, admin)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'Fixed in v2' })
      .expect(201);
    const list = await as(ctx, member).get(`/api/v1/records/${id}/comments`).expect(200);
    expect(list.body.map((c: { body: string }) => c.body)).toEqual([
      'Please check the amount',
      'Fixed in v2',
    ]);
    const audit = await as(ctx, admin)
      .get(`/api/v1/audit?resourceId=${id}&action=COMMENT_ADDED`)
      .expect(200);
    expect(audit.body.total).toBe(2);
  });

  it('validates the body', async () => {
    const { id } = await createRecord(ctx, admin, ws);
    await as(ctx, admin).post(`/api/v1/records/${id}/comments`).send({ body: '   ' }).expect(400);
    await as(ctx, admin)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'x'.repeat(4001) })
      .expect(400);
  });

  it('lets authors delete their own comments and admins moderate, but not members', async () => {
    const { id } = await createRecord(ctx, admin, ws);
    const byAdmin = await as(ctx, admin)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'Admin note' })
      .expect(201);
    const byMember = await as(ctx, member)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'Member note' })
      .expect(201);
    await as(ctx, member).delete(`/api/v1/records/${id}/comments/${byAdmin.body.id}`).expect(403);
    await as(ctx, member).delete(`/api/v1/records/${id}/comments/${byMember.body.id}`).expect(204);
    const again = await as(ctx, admin)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'Another' })
      .expect(201);
    const second = await as(ctx, member)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'Spam' })
      .expect(201);
    await as(ctx, admin).delete(`/api/v1/records/${id}/comments/${second.body.id}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/records/${id}/comments/not-an-id`).expect(404);
    const list = await as(ctx, admin).get(`/api/v1/records/${id}/comments`).expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([byAdmin.body.id, again.body.id]);
    const denied = await as(ctx, admin)
      .get(`/api/v1/audit?action=ACCESS_DENIED&resourceId=${id}`)
      .expect(200);
    expect(denied.body.items[0].context.attemptedAction).toBe('comments.moderate');
  });

  it('hides comments of trashed records and removes them on purge', async () => {
    const { id } = await createRecord(ctx, admin, ws);
    await as(ctx, admin)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'Soon gone' })
      .expect(201);
    await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    await as(ctx, admin).get(`/api/v1/records/${id}/comments`).expect(404);
    await as(ctx, admin).post(`/api/v1/records/${id}/comments`).send({ body: 'x' }).expect(404);
    await as(ctx, admin).delete(`/api/v1/trash/records/${id}`).expect(200);
    const model = ctx.app.get<Model<RecordComment>>(getModelToken(RecordComment.name));
    expect(await model.countDocuments({ recordId: new Types.ObjectId(id) })).toBe(0);
  });

  it('isolates comments between tenants', async () => {
    const { id } = await createRecord(ctx, admin, ws);
    const comment = await as(ctx, admin)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: 'Internal' })
      .expect(201);
    await as(ctx, other).get(`/api/v1/records/${id}/comments`).expect(404);
    await as(ctx, other).post(`/api/v1/records/${id}/comments`).send({ body: 'Hello' }).expect(404);
    await as(ctx, other).delete(`/api/v1/records/${id}/comments/${comment.body.id}`).expect(404);
    await ctx.http().get(`/api/v1/records/${id}/comments`).expect(401);
  });
});
