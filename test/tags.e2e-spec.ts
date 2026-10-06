import { RecordState } from '../src/records/record-state.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('tags (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Tag Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('accepts tags at creation, normalises them and exposes a tag cloud', async () => {
    const created = await as(ctx, admin)
      .post('/api/v1/records')
      .send({
        name: 'Tagged',
        contentTypeId: ws.typeId,
        folderId: ws.folderId,
        metadata: { supplier: 'A', amount: 1 },
        tags: [' Urgent ', 'q3-audit', 'urgent'],
      })
      .expect(201);
    expect(created.body.tags).toEqual(['q3-audit', 'urgent']);
    const viaForm = await as(ctx, admin)
      .post('/api/v1/records')
      .field('name', 'Form tagged')
      .field('contentTypeId', ws.typeId)
      .field('folderId', ws.folderId)
      .field('metadata', JSON.stringify({ supplier: 'B', amount: 2 }))
      .field('tags', 'urgent, finance')
      .expect(201);
    expect(viaForm.body.tags).toEqual(['finance', 'urgent']);
    const cloud = await as(ctx, member).get('/api/v1/tags').expect(200);
    expect(cloud.body).toEqual([
      { tag: 'urgent', count: 2 },
      { tag: 'finance', count: 1 },
      { tag: 'q3-audit', count: 1 },
    ]);
  });

  it('replaces tags without creating a version, audits the change and filters by tag', async () => {
    const { id } = await createRecord(ctx, member, ws, { name: 'Retag me' });
    const updated = await as(ctx, member)
      .put(`/api/v1/records/${id}/tags`)
      .send({ tags: ['contract', 'Legal Hold'] })
      .expect(200);
    expect(updated.body).toMatchObject({ tags: ['contract', 'legal hold'], currentVersion: 1 });
    const byTag = await as(ctx, admin).get('/api/v1/records?tag=legal%20hold').expect(200);
    expect(byTag.body.items.map((r: { id: string }) => r.id)).toEqual([id]);
    const both = await as(ctx, admin).get('/api/v1/records?tag=contract,legal%20hold').expect(200);
    expect(both.body.total).toBe(1);
    expect(
      (await as(ctx, admin).get('/api/v1/records?tag=contract,urgent').expect(200)).body.total,
    ).toBe(0);
    expect(
      (await as(ctx, admin).get('/api/v1/records?q=legal%20hold').expect(200)).body.total,
    ).toBe(1);
    const audit = await as(ctx, admin)
      .get(`/api/v1/audit?resourceId=${id}&action=RECORD_TAGS_CHANGED`)
      .expect(200);
    expect(audit.body.items[0].context).toEqual({ added: ['contract', 'legal hold'], removed: [] });
  });

  it('validates tags and respects check-out', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Locked tags' });
    const bad = await as(ctx, admin)
      .put(`/api/v1/records/${id}/tags`)
      .send({ tags: ['ok', '<script>'] })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    await as(ctx, admin)
      .put(`/api/v1/records/${id}/tags`)
      .send({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })
      .expect(400);
    await as(ctx, admin).post(`/api/v1/records/${id}/checkout`).expect(200);
    const locked = await as(ctx, member)
      .put(`/api/v1/records/${id}/tags`)
      .send({ tags: ['x'] })
      .expect(409);
    expect(locked.body.code).toBe('RECORD_CHECKED_OUT');
  });

  it('refuses a tag replacement when someone checks the record out mid-request, and keeps the tags and the lock', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Raced tags' });
    await as(ctx, admin)
      .put(`/api/v1/records/${id}/tags`)
      .send({ tags: ['before'] })
      .expect(200);
    const state = ctx.app.get(RecordState);
    const requireLive = state.requireLive.bind(state);
    const spy = vi.spyOn(state, 'requireLive').mockImplementationOnce(async (...args) => {
      const read = await requireLive(...args);
      await as(ctx, member).post(`/api/v1/records/${id}/checkout`).expect(200);
      return read;
    });
    try {
      const res = await as(ctx, admin)
        .put(`/api/v1/records/${id}/tags`)
        .send({ tags: ['after'] })
        .expect(409);
      expect(res.body.code).toBe('RECORD_CHECKED_OUT');
      expect(res.body.message).toBe(`This record is checked out by ${member.displayName}`);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const record = await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200);
    expect(record.body.record.tags).toEqual(['before']);
    expect(record.body.record.checkedOut).toMatchObject({ id: member.userId });
    const audit = await as(ctx, admin)
      .get(`/api/v1/audit?action=RECORD_TAGS_CHANGED&resourceId=${id}`)
      .expect(200);
    expect(audit.body.total).toBe(1);
  });

  it('keeps tags and tag clouds inside the tenant', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Private tags' });
    await as(ctx, admin)
      .put(`/api/v1/records/${id}/tags`)
      .send({ tags: ['secret-project'] })
      .expect(200);
    expect((await as(ctx, other).get('/api/v1/tags').expect(200)).body).toEqual([]);
    expect(
      (await as(ctx, other).get('/api/v1/records?tag=secret-project').expect(200)).body.total,
    ).toBe(0);
    await as(ctx, other)
      .put(`/api/v1/records/${id}/tags`)
      .send({ tags: ['stolen'] })
      .expect(404);
    await ctx.http().get('/api/v1/tags').expect(401);
  });
});
