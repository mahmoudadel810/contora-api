import { Types } from 'mongoose';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface Entry {
  id: string;
  action: string;
  actor: { id: string } | null;
  resource: { type: string; id: string } | null;
  context: Record<string, unknown>;
  createdAt: string;
}

describe('record activity feed (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let peer: Actor;
  let other: Actor;
  let ws: Workspace;
  let recordId: string;
  let deletedCommentId: string;
  let keptCommentId: string;

  const feed = (actor: Actor, id: string, query = '') =>
    as(ctx, actor).get(`/api/v1/records/${id}/activity${query}`);

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Feed Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    peer = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, peer);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
    recordId = (await createRecord(ctx, admin, ws, { name: 'Contract' })).id;

    await as(ctx, member)
      .patch(`/api/v1/records/${recordId}`)
      .send({ name: 'Contract v2' })
      .expect(200);
    deletedCommentId = (
      await as(ctx, member)
        .post(`/api/v1/records/${recordId}/comments`)
        .send({ body: 'moderated words' })
        .expect(201)
    ).body.id;
    keptCommentId = (
      await as(ctx, member)
        .post(`/api/v1/records/${recordId}/comments`)
        .send({ body: 'a fine remark' })
        .expect(201)
    ).body.id;
    await as(ctx, peer)
      .delete(`/api/v1/records/${recordId}/comments/${deletedCommentId}`)
      .expect(403);
    await as(ctx, admin)
      .delete(`/api/v1/records/${recordId}/comments/${deletedCommentId}`)
      .expect(204);
    await as(ctx, admin).post(`/api/v1/records/${recordId}/checkout`).expect(200);
    await as(ctx, member).post(`/api/v1/records/${recordId}/force-release`).expect(403);
    await as(ctx, admin).post(`/api/v1/records/${recordId}/checkin`).expect(200);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('shows every user’s entries about the record, newest first, without ACCESS_DENIED', async () => {
    const res = await feed(peer, recordId).expect(200);
    const items = res.body.items as Entry[];
    expect(res.body).toMatchObject({ page: 1, pageSize: 20 });
    expect(items.map((e) => e.action)).toEqual([
      'RECORD_CHECKED_IN',
      'RECORD_CHECKED_OUT',
      'COMMENT_DELETED',
      'COMMENT_ADDED',
      'COMMENT_ADDED',
      'RECORD_UPDATED',
      'RECORD_CREATED',
    ]);
    expect(res.body.total).toBe(items.length);
    expect(new Set(items.map((e) => e.actor?.id))).toEqual(new Set([admin.userId, member.userId]));
    expect(items.every((e) => e.resource?.type === 'record' && e.resource.id === recordId)).toBe(
      true,
    );
    const times = items.map((e) => e.createdAt);
    expect([...times].sort().reverse()).toEqual(times);

    const denied = await as(ctx, admin)
      .get(`/api/v1/audit?action=ACCESS_DENIED&resourceId=${recordId}`)
      .expect(200);
    expect(denied.body.total).toBe(2);
  });

  it('strips the text and author of a deleted comment, but not from the audit log', async () => {
    const items = (await feed(member, recordId).expect(200)).body.items as Entry[];
    const deleted = items.find((e) => e.action === 'COMMENT_DELETED');
    expect(deleted?.context).toEqual({ commentId: deletedCommentId });
    const added = items.filter((e) => e.action === 'COMMENT_ADDED');
    expect(added.find((e) => e.context.commentId === deletedCommentId)?.context).toEqual({
      commentId: deletedCommentId,
      mentionCount: 0,
    });
    expect(added.find((e) => e.context.commentId === keptCommentId)?.context).toEqual({
      commentId: keptCommentId,
      excerpt: 'a fine remark',
      mentionCount: 0,
    });
    expect(JSON.stringify(items)).not.toContain('moderated words');

    const log = await as(ctx, admin)
      .get(`/api/v1/audit?action=COMMENT_DELETED&resourceId=${recordId}`)
      .expect(200);
    expect(log.body.items[0].context).toMatchObject({
      commentId: deletedCommentId,
      excerpt: 'moderated words',
    });
  });

  it('pages through the feed', async () => {
    const all = (await feed(member, recordId, '?pageSize=100').expect(200)).body;
    const first = (await feed(member, recordId, '?page=1&pageSize=3').expect(200)).body;
    const second = (await feed(member, recordId, '?page=2&pageSize=3').expect(200)).body;
    const third = (await feed(member, recordId, '?page=3&pageSize=3').expect(200)).body;
    expect(first).toMatchObject({ page: 1, pageSize: 3, total: all.total });
    expect([...first.items, ...second.items, ...third.items]).toEqual(all.items);
    const beyond = (await feed(member, recordId, '?page=9&pageSize=3').expect(200)).body;
    expect(beyond.items).toEqual([]);
  });

  it('validates the query strictly', async () => {
    for (const query of ['?pageSize=0', '?pageSize=101', '?page=0', '?action=SIGN_IN']) {
      const res = await feed(member, recordId, query).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('leaves out relation entries written on the other record', async () => {
    const target = (await createRecord(ctx, admin, ws, { name: 'Annex' })).id;
    await as(ctx, member)
      .post(`/api/v1/records/${recordId}/relations`)
      .send({ kind: 'references', otherId: target })
      .expect(201);
    const theirs = (await feed(member, target).expect(200)).body.items as Entry[];
    expect(theirs.map((e) => e.action)).toEqual(['RECORD_CREATED']);
    const ours = (await feed(member, recordId).expect(200)).body.items as Entry[];
    expect(ours[0].action).toBe('RELATION_ADDED');
  });

  it('is 404 for a trashed, purged, unknown or malformed record', async () => {
    const trashed = (await createRecord(ctx, admin, ws, { name: 'Trashed' })).id;
    await as(ctx, admin).delete(`/api/v1/records/${trashed}`).expect(204);
    await feed(member, trashed).expect(404);

    const purged = (await createRecord(ctx, admin, ws, { name: 'Purged' })).id;
    await as(ctx, admin).delete(`/api/v1/records/${purged}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/trash/records/${purged}`).expect(200);
    await feed(admin, purged).expect(404);

    await feed(member, new Types.ObjectId().toHexString()).expect(404);
    const malformed = await feed(member, 'not-an-id').expect(404);
    expect(malformed.body.code).toBe('NOT_FOUND');
  });

  it('is 404 for another tenant’s record and requires authentication', async () => {
    const res = await feed(other, recordId).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
    await ctx.http().get(`/api/v1/records/${recordId}/activity`).expect(401);
  });
});
