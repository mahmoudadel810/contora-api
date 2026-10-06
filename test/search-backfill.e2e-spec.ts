import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { searchKey } from '../src/common/arabic-normalize.js';
import { RecordsRepository } from '../src/records/records.repository.js';
import {
  SearchBackfill,
  type BackfillOptions,
  type BackfillSummary,
} from '../src/records/search-backfill.js';
import { Tenant } from '../src/tenants/tenant.schema.js';
import { as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { makeLegacy, recordsCollection, storedKeys, storedRecord } from './helpers/search-keys.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const enc = encodeURIComponent;

const TEXTS = ['أحمد', 'احمد', 'مدرسة', 'مدرسه', 'Content legacy', 'نص', 'Acme', 'secret'];

describe('search-key backfill (e2e)', () => {
  let ctx: TestApp;
  let records: RecordsRepository;
  let backfill: SearchBackfill;
  const lines: string[] = [];

  const run = (options: BackfillOptions = {}) =>
    backfill.run({ pauseMs: 0, log: (line) => lines.push(line), ...options });

  const total = async (actor: Actor, query: string) =>
    (await as(ctx, actor).get(`/api/v1/records?${query}`).expect(200)).body.total as number;

  async function legacyTenant(
    name: string,
    recordNames: string[],
  ): Promise<{ admin: Actor; ws: Workspace; ids: string[] }> {
    const admin = await signUp(ctx, { tenantName: name });
    const ws = await workspace(ctx, admin);
    const ids: string[] = [];
    for (const recordName of recordNames) {
      const { id } = await createRecord(ctx, admin, ws, {
        name: recordName,
        metadata: { supplier: 'مؤسسة أحمد', amount: 1 },
      });
      await makeLegacy(ctx, id);
      ids.push(id);
    }
    return { admin, ws, ids };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    records = ctx.app.get(RecordsRepository, { strict: false });
    backfill = new SearchBackfill(
      records,
      ctx.app.get<Model<Tenant>>(getModelToken(Tenant.name), { strict: false }),
    );
  });

  afterAll(async () => {
    await ctx.stop();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it('keeps legacy records findable, then folds them; idempotent, tenant-safe, no updatedAt', async () => {
    const a = await legacyTenant('Backfill A', ['أحمد القديم', 'Content legacy']);
    const trashed = (await createRecord(ctx, a.admin, a.ws, { name: 'مدرسة قديمة' })).id;
    await as(ctx, a.admin).delete(`/api/v1/records/${trashed}`).expect(204);
    await makeLegacy(ctx, trashed);
    await makeLegacy(ctx, a.ids[1], { contentText: 'نص عربي' });
    const b = await legacyTenant('Backfill B', ['أحمد في الشركة الأخرى']);
    const updatedBefore = (await storedRecord(ctx, a.ids[0]))?.['updatedAt'];

    expect(await total(a.admin, `q=${enc('أحمد القديم')}`)).toBe(1);
    expect(await total(a.admin, `q=${enc('احمد القديم')}`)).toBe(0);
    expect(await total(a.admin, `q=${enc('احمد في الشركه')}`)).toBe(0);

    const first = await run();
    expect(first.failed).toBe(0);
    expect(first.remaining).toBe(0);
    expect(first.updated).toBe(4);

    expect(await total(a.admin, `q=${enc('احمد القديم')}`)).toBe(1);
    expect(await total(a.admin, `contentTypeId=${a.ws.typeId}&meta.supplier=${enc('موسسه')}`)).toBe(
      2,
    );
    await as(ctx, a.admin).post(`/api/v1/trash/records/${trashed}/restore`).expect(200);
    expect(await total(a.admin, `q=${enc('مدرسه قديمه')}`)).toBe(1);
    expect(await storedKeys(ctx, a.ids[0])).toEqual({
      text: expect.stringContaining('احمد القديم'),
      v: 1,
      meta: { supplier: searchKey('مؤسسة أحمد'), status: 'open' },
      mv: 1,
    });
    const content = await storedRecord(ctx, a.ids[1]);
    expect(content?.['contentText']).toBe('نص عربي');
    expect((await storedKeys(ctx, a.ids[1]))?.content).toBeUndefined();

    expect(await total(a.admin, `q=${enc('احمد في الشركه')}`)).toBe(0);
    const exported = await as(ctx, a.admin)
      .get(`/api/v1/records/export?q=${enc('احمد في الشركه')}`)
      .expect(200);
    expect(exported.headers['x-export-count']).toBe('0');
    expect(await total(b.admin, `q=${enc('احمد في الشركه')}`)).toBe(1);

    expect((await storedRecord(ctx, a.ids[0]))?.['updatedAt']).toEqual(updatedBefore);

    const second = await run();
    expect(second).toMatchObject({ scanned: 0, updated: 0, skipped: 0, failed: 0, remaining: 0 });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const text of TEXTS) expect(line).not.toContain(text);
      expect(line).toMatch(/^(dry run )?(tenant [0-9a-f]{24}|total over)/);
    }
  });

  it('counts a record that fails as failed, logs only the error name, and goes on', async () => {
    const t = await legacyTenant('Backfill failure', ['one', 'two', 'three']);
    const updateDerived = vi
      .spyOn(records, 'updateDerived')
      .mockRejectedValueOnce(
        Object.assign(new Error('Validation failed: secret أحمد'), { name: 'ValidationError' }),
      );
    let summary: BackfillSummary | undefined;
    try {
      summary = await run({ tenantId: t.admin.tenantId });
    } finally {
      updateDerived.mockRestore();
    }
    expect(summary).toMatchObject({ scanned: 3, updated: 2, failed: 1, remaining: 1 });
    const failure = lines.find((line) => line.includes('failed: ValidationError'));
    expect(failure).toMatch(/^tenant [0-9a-f]{24}: record [0-9a-f]{24} failed: ValidationError$/);
    for (const line of lines) for (const text of TEXTS) expect(line).not.toContain(text);

    await recordsCollection(ctx).updateOne(
      { _id: new Types.ObjectId(t.ids[0]) },
      { $set: { search: 'garbage' } },
    );
    const next = await run({ tenantId: t.admin.tenantId });
    expect(next.failed).toBe(1);
    expect(next.scanned).toBe(next.failed + next.updated + next.skipped);
  });

  it('resumes after a crash and ends in the same state; --dry-run and --tenant', async () => {
    const t = await legacyTenant('Backfill resume', ['r1', 'r2', 'r3', 'r4', 'r5']);
    const untouched = await legacyTenant('Backfill untouched', ['u1']);

    const dry = await run({ tenantId: t.admin.tenantId, dryRun: true });
    expect(dry).toMatchObject({ scanned: 5, updated: 0, remaining: 5 });
    expect(await storedKeys(ctx, t.ids[0])).toBeUndefined();

    const page = records.backfillPage.bind(records);
    const spy = vi
      .spyOn(records, 'backfillPage')
      .mockImplementationOnce(page)
      .mockRejectedValueOnce(
        Object.assign(new Error('connection lost'), { name: 'MongoNetworkError' }),
      );
    try {
      await expect(run({ tenantId: t.admin.tenantId, batchSize: 2 })).rejects.toThrow(
        'connection lost',
      );
    } finally {
      spy.mockRestore();
    }
    const keyed = await Promise.all(t.ids.map((id) => storedKeys(ctx, id)));
    expect(keyed.filter((keys) => keys?.v === 1)).toHaveLength(2);

    const resumed = await run({ tenantId: t.admin.tenantId, batchSize: 2 });
    expect(resumed).toMatchObject({ scanned: 3, updated: 3, failed: 0, remaining: 0 });
    for (const id of t.ids) {
      expect(await storedKeys(ctx, id)).toMatchObject({ v: 1, mv: 1 });
    }
    expect(await run({ tenantId: t.admin.tenantId })).toMatchObject({ scanned: 0, updated: 0 });
    expect(await storedKeys(ctx, untouched.ids[0])).toBeUndefined();
  });

  it('recomputes keys behind a current marker with --all', async () => {
    const admin = await signUp(ctx, { tenantName: 'Backfill all' });
    const ws = await workspace(ctx, admin);
    const { id } = await createRecord(ctx, admin, ws, {
      name: 'أحمد',
      metadata: { supplier: 'x', amount: 1 },
    });
    await recordsCollection(ctx).updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { 'search.text': 'stale', 'search.meta': {} } },
    );
    expect(await run({ tenantId: admin.tenantId })).toMatchObject({ scanned: 0, updated: 0 });
    expect(await total(admin, `q=${enc('احمد')}`)).toBe(0);
    const all = await run({ tenantId: admin.tenantId, all: true });
    expect(all).toMatchObject({ scanned: 1, updated: 1, failed: 0 });
    expect(await total(admin, `q=${enc('احمد')}`)).toBe(1);
    expect(await total(admin, `contentTypeId=${ws.typeId}&meta.supplier=x`)).toBe(1);
  });

  describe('races with live writes', () => {
    it('misses when a rename commits between the read and the update', async () => {
      const t = await legacyTenant('Backfill race rename', ['Before']);
      const page = records.backfillPage.bind(records);
      const spy = vi.spyOn(records, 'backfillPage').mockImplementationOnce(async (...args) => {
        const rows = await page(...args);
        await as(ctx, t.admin)
          .patch(`/api/v1/records/${t.ids[0]}`)
          .send({ name: 'أحمد بعد' })
          .expect(200);
        return rows;
      });
      let summary: BackfillSummary | undefined;
      try {
        summary = await run({ tenantId: t.admin.tenantId });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(summary).toMatchObject({ scanned: 1, skipped: 1, updated: 0, remaining: 0 });
      const keys = await storedKeys(ctx, t.ids[0]);
      expect(keys?.text).toContain('احمد بعد');
      expect(keys?.text).not.toContain('before');
      expect(keys).toMatchObject({ v: 1, mv: 1 });
    });

    it('misses when a new version commits between the read and the update', async () => {
      const t = await legacyTenant('Backfill race version', ['Versioned']);
      const page = records.backfillPage.bind(records);
      const spy = vi.spyOn(records, 'backfillPage').mockImplementationOnce(async (...args) => {
        const rows = await page(...args);
        await as(ctx, t.admin)
          .post(`/api/v1/records/${t.ids[0]}/versions`)
          .send({ metadata: { supplier: 'مدرسة جديدة', amount: 2 }, comment: 'meanwhile' })
          .expect(201);
        return rows;
      });
      let summary: BackfillSummary | undefined;
      try {
        summary = await run({ tenantId: t.admin.tenantId });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(summary).toMatchObject({ scanned: 1, skipped: 1, updated: 0, remaining: 0 });
      const keys = await storedKeys(ctx, t.ids[0]);
      expect(keys?.meta).toEqual({ supplier: searchKey('مدرسة جديدة'), status: 'open' });
      expect(keys?.text).toContain(searchKey('مدرسة جديدة'));
    });
  });
});
