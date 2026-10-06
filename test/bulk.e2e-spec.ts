import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { RecordsRepository } from '../src/records/records.repository.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('bulk actions (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;
  let archiveId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Bulk Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
    archiveId = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Archive', parentId: ws.rootId })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await ctx.stop();
  });

  async function three(prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (const n of [1, 2, 3])
      ids.push((await createRecord(ctx, admin, ws, { name: `${prefix} ${n}` })).id);
    return ids;
  }

  it('moves several records, including one checked out by someone else, and reports unknown ids', async () => {
    const [a, b, c] = await three('Move');
    await as(ctx, admin).post(`/api/v1/records/${c}/checkout`).expect(200);
    const res = await as(ctx, member)
      .post('/api/v1/bulk/records/move')
      .send({ ids: [a, b, c, 'nope'], folderId: archiveId })
      .expect(200);
    expect(res.body.succeeded).toBe(3);
    expect(res.body.results.find((r: { id: string }) => r.id === 'nope')).toEqual({
      id: 'nope',
      ok: false,
      code: 'NOT_FOUND',
      message: 'Record not found',
    });
    const inArchive = await as(ctx, admin).get(`/api/v1/records?folderId=${archiveId}`).expect(200);
    expect(inArchive.body.items.map((r: { id: string }) => r.id).sort()).toEqual([a, b, c].sort());
    const audit = await as(ctx, admin)
      .get(`/api/v1/audit?action=RECORD_MOVED&actorId=${member.userId}`)
      .expect(200);
    expect(audit.body.total).toBe(3);
  });

  it('trashes several records and reports the locked one', async () => {
    const [a, b, c] = await three('Trash');
    await as(ctx, admin).post(`/api/v1/records/${c}/checkout`).expect(200);
    const res = await as(ctx, member)
      .post('/api/v1/bulk/records/trash')
      .send({ ids: [a, b, c] })
      .expect(200);
    expect(res.body).toMatchObject({ succeeded: 2, failed: 1 });
    expect(res.body.results.find((r: { id: string }) => r.id === c)).toMatchObject({
      ok: false,
      code: 'RECORD_CHECKED_OUT',
    });
    await as(ctx, admin).get(`/api/v1/records/${a}`).expect(404);
    await as(ctx, admin).get(`/api/v1/records/${c}`).expect(200);
  });

  it('adds and removes tags across records', async () => {
    const [a, b] = await three('Tag');
    await as(ctx, admin)
      .put(`/api/v1/records/${a}/tags`)
      .send({ tags: ['old', 'keep'] })
      .expect(200);
    const res = await as(ctx, admin)
      .post('/api/v1/bulk/records/tags')
      .send({ ids: [a, b], add: ['Q4'], remove: ['old'] })
      .expect(200);
    expect(res.body.succeeded).toBe(2);
    expect((await as(ctx, admin).get(`/api/v1/records/${a}`).expect(200)).body.record.tags).toEqual(
      ['keep', 'q4'],
    );
    expect((await as(ctx, admin).get(`/api/v1/records/${b}`).expect(200)).body.record.tags).toEqual(
      ['q4'],
    );
    await as(ctx, admin)
      .post('/api/v1/bulk/records/tags')
      .send({ ids: [a] })
      .expect(400);
  });

  it('keeps a tag change made while a bulk retag was in flight', async () => {
    const [a] = await three('Race');
    await as(ctx, admin)
      .put(`/api/v1/records/${a}/tags`)
      .send({ tags: ['base'] })
      .expect(200);
    const records = ctx.app.get(RecordsRepository, { strict: false });
    const updateOne = records.updateOne.bind(records);
    const spy = vi.spyOn(records, 'updateOne').mockImplementationOnce(async (...args) => {
      await as(ctx, member)
        .post('/api/v1/bulk/records/tags')
        .send({ ids: [a], add: ['theirs'] })
        .expect(200);
      return updateOne(...args);
    });
    try {
      const res = await as(ctx, admin)
        .post('/api/v1/bulk/records/tags')
        .send({ ids: [a], add: ['mine'] })
        .expect(200);
      expect(res.body.succeeded).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const record = await as(ctx, admin).get(`/api/v1/records/${a}`).expect(200);
    expect(record.body.record.tags).toEqual(['base', 'mine', 'theirs']);
    const audit = await as(ctx, admin)
      .get(`/api/v1/audit?action=RECORD_TAGS_CHANGED&resourceId=${a}`)
      .expect(200);
    expect(audit.body.items.map((e: { context: { added: string[] } }) => e.context.added)).toEqual(
      expect.arrayContaining([['mine'], ['theirs']]),
    );
  });

  it('refuses a retag in a fixed order: unknown, too many tags, then someone else’s check-out', async () => {
    const [held, full] = await three('Order');
    await as(ctx, admin)
      .put(`/api/v1/records/${held}/tags`)
      .send({ tags: ['kept'] })
      .expect(200);
    const twenty = Array.from({ length: 20 }, (_, n) => `t${n}`);
    await as(ctx, admin).put(`/api/v1/records/${full}/tags`).send({ tags: twenty }).expect(200);
    await as(ctx, member).post(`/api/v1/records/${held}/checkout`).expect(200);
    await as(ctx, member).post(`/api/v1/records/${full}/checkout`).expect(200);
    const code = async (ids: string[], add: string[]) => {
      const res = await as(ctx, admin)
        .post('/api/v1/bulk/records/tags')
        .send({ ids, add })
        .expect(200);
      return res.body.results.map((r: { ok: boolean; code?: string }) => r.code ?? 'ok');
    };
    expect(await code(['nope'], ['x'])).toEqual(['NOT_FOUND']);
    expect(await code([full], ['one-more'])).toEqual(['TOO_MANY_TAGS']);
    expect(await code([held], ['kept'])).toEqual(['ok']);
    const audit = await as(ctx, admin)
      .get(`/api/v1/audit?action=RECORD_TAGS_CHANGED&resourceId=${held}`)
      .expect(200);
    expect(audit.body.total).toBe(1);
    expect(await code([held], ['new'])).toEqual(['RECORD_CHECKED_OUT']);
  });

  it('gives up with WRITE_CONFLICT when the tags keep changing under a retag', async () => {
    const [a] = await three('Busy');
    const records = ctx.app.get(RecordsRepository, { strict: false });
    const spy = vi.spyOn(records, 'updateOne').mockResolvedValue(null);
    try {
      const res = await as(ctx, admin)
        .post('/api/v1/bulk/records/tags')
        .send({ ids: [a], add: ['x'] })
        .expect(200);
      expect(res.body.results[0]).toEqual({
        id: a,
        ok: false,
        code: 'WRITE_CONFLICT',
        message: 'The record changed while saving; please retry',
      });
      expect(spy).toHaveBeenCalledTimes(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('validates the request size', async () => {
    await as(ctx, admin).post('/api/v1/bulk/records/trash').send({ ids: [] }).expect(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => `id${i}`);
    await as(ctx, admin).post('/api/v1/bulk/records/trash').send({ ids: tooMany }).expect(400);
  });

  it("never touches another tenant's records", async () => {
    const [a] = await three('Mine');
    const otherRoot = (await as(ctx, other).get('/api/v1/folders/root').expect(200)).body.folder.id;
    const moved = await as(ctx, other)
      .post('/api/v1/bulk/records/move')
      .send({ ids: [a], folderId: otherRoot })
      .expect(200);
    expect(moved.body.results[0]).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const trashed = await as(ctx, other)
      .post('/api/v1/bulk/records/trash')
      .send({ ids: [a] })
      .expect(200);
    expect(trashed.body.results[0].ok).toBe(false);
    const tagged = await as(ctx, other)
      .post('/api/v1/bulk/records/tags')
      .send({ ids: [a], add: ['x'] })
      .expect(200);
    expect(tagged.body.results[0].ok).toBe(false);
    const cross = await as(ctx, admin)
      .post('/api/v1/bulk/records/move')
      .send({ ids: [a], folderId: otherRoot })
      .expect(200);
    expect(cross.body.results[0]).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    await as(ctx, admin).get(`/api/v1/records/${a}`).expect(200);
    await ctx
      .http()
      .post('/api/v1/bulk/records/trash')
      .send({ ids: [a] })
      .expect(401);
  });
});
