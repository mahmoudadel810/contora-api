import { Types } from 'mongoose';
import { RecordsRepository } from '../src/records/records.repository.js';
import { as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { recordsCollection } from './helpers/search-keys.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

function maxTimeExpired(): Error {
  return Object.assign(new Error('operation exceeded time limit'), {
    name: 'MongoServerError',
    code: 50,
    codeName: 'MaxTimeMSExpired',
  });
}

describe('text-search time limit (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp([], { SEARCH_MAX_TIME_MS: '200' });
    admin = await signUp(ctx, { tenantName: 'Timeout Co' });
    ws = await workspace(ctx, admin);
    const template = await createRecord(ctx, admin, ws, { name: 'Template' });
    const stored = await recordsCollection(ctx).findOne({
      _id: new Types.ObjectId(template.id),
    });
    if (!stored) throw new Error('template record missing');
    const long = 'ب'.repeat(50_000) + 'x'.repeat(50_000);
    const { _id: _templateId, ...rest } = stored;
    const docs = Array.from({ length: 200 }, (_, i) => ({
      ...rest,
      _id: new Types.ObjectId(),
      name: `Long ${i}`,
      searchText: long,
      search: { text: long, v: 1, meta: {}, mv: 1 },
    }));
    await recordsCollection(ctx).insertMany(docs);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('answers a heavy text search with 200 or 503, never 500, and keeps serving', async () => {
    const q = encodeURIComponent('بx'.repeat(100));
    for (const url of [`/api/v1/records?q=${q}`, `/api/v1/records/export?q=${q}`]) {
      const res = await as(ctx, admin).get(url);
      expect([200, 503]).toContain(res.status);
      if (res.status === 503) expect(res.body.code).toBe('SEARCH_TIMEOUT');
    }
    await ctx.http().get('/api/v1/health').expect(200);
    await as(ctx, admin).get('/api/v1/records?pageSize=1').expect(200);
  });
});

describe('text-search time limit plumbing (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp([], { SEARCH_MAX_TIME_MS: '200' });
    admin = await signUp(ctx, { tenantName: 'Timeout Plumbing Co' });
    ws = await workspace(ctx, admin);
    await createRecord(ctx, admin, ws, { name: 'Template' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('runs text searches with maxTimeMS, and other lists without', async () => {
    const records = ctx.app.get(RecordsRepository, { strict: false });
    const page = vi.spyOn(records, 'page');
    const find = vi.spyOn(records, 'find');
    try {
      await as(ctx, admin).get('/api/v1/records?q=template').expect(200);
      expect(page.mock.calls[0][5]).toEqual({ maxTimeMS: 200 });
      await as(ctx, admin)
        .get(`/api/v1/records?contentTypeId=${ws.typeId}&meta.supplier=acme`)
        .expect(200);
      expect(page.mock.calls[1][5]).toEqual({ maxTimeMS: 200 });
      await as(ctx, admin).get('/api/v1/records?meta.amount=1').expect(200);
      expect(page.mock.calls[2][5]).toEqual({});
      await as(ctx, admin).get('/api/v1/records').expect(200);
      expect(page.mock.calls[3][5]).toEqual({});
      await as(ctx, admin).get('/api/v1/records/export?q=template').expect(200);
      expect(find.mock.calls.some((call) => call[2]?.maxTimeMS === 200)).toBe(true);
    } finally {
      page.mockRestore();
      find.mockRestore();
    }
  });

  it('turns MaxTimeMSExpired into 503 SEARCH_TIMEOUT on the list and the export', async () => {
    const records = ctx.app.get(RecordsRepository, { strict: false });
    const page = vi.spyOn(records, 'page').mockRejectedValueOnce(maxTimeExpired());
    const find = vi.spyOn(records, 'find').mockRejectedValueOnce(maxTimeExpired());
    try {
      const listed = await as(ctx, admin).get('/api/v1/records?q=a').expect(503);
      expect(listed.body).toMatchObject({ statusCode: 503, code: 'SEARCH_TIMEOUT' });
      expect(JSON.stringify(listed.body)).not.toContain('exceeded');
      const exported = await as(ctx, admin).get('/api/v1/records/export?q=a').expect(503);
      expect(exported.body.code).toBe('SEARCH_TIMEOUT');
      expect(page).toHaveBeenCalled();
      expect(find).toHaveBeenCalled();
    } finally {
      page.mockRestore();
      find.mockRestore();
    }
    await as(ctx, admin).get('/api/v1/records?q=a').expect(200);
  });
});
