import { searchKey } from '../src/common/arabic-normalize.js';
import { RecordsRepository } from '../src/records/records.repository.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, grantAccess, workspace, type Workspace } from './helpers/fixtures.js';
import { makeLegacy, storedKeys } from './helpers/search-keys.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

type Listed = { id: string; name: string };

const HARAKAT_AHMAD = 'أَحْمَد';
const REGEX_NAME = 'Budget (Q3) a+b [v2] c\\d';

const enc = encodeURIComponent;

describe('Arabic-aware search (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let other: Actor;
  let ws: Workspace;
  let letterTypeId: string;
  const ids: Record<string, string> = {};
  const letters: Record<string, string> = {};

  const list = async (actor: Actor, query: string) =>
    (await as(ctx, actor).get(`/api/v1/records?pageSize=100&${query}`).expect(200)).body as {
      items: Listed[];
      total: number;
    };
  const names = async (actor: Actor, query: string) =>
    (await list(actor, query)).items.map((r) => r.name).sort();

  const letter = async (key: string, name: string, sender: string, subject: string) => {
    const res = await as(ctx, admin)
      .post('/api/v1/records')
      .send({
        name,
        contentTypeId: letterTypeId,
        folderId: ws.rootId,
        metadata: { sender, subject },
      })
      .expect(201);
    letters[key] = res.body.id as string;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Arabic Co' });
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin, 'Arabic');
    for (const name of [
      'احمد',
      'أحمد',
      'إحمد',
      'آحمد',
      HARAKAT_AHMAD,
      'مدرسة النور',
      'مستشفى المدينة',
      'مستشفي الأمل',
      'Invoice 123',
      'فاتورة ١٢٣',
      REGEX_NAME,
      'Quarterly overview',
    ]) {
      ids[name] = (
        await createRecord(ctx, admin, ws, { name, metadata: { supplier: 'Acme', amount: 5 } })
      ).id;
    }
    letterTypeId = (
      await as(ctx, admin)
        .post('/api/v1/content-types')
        .send({
          name: 'Letter',
          fields: [
            { key: 'sender', label: 'Sender', type: 'text', required: true },
            { key: 'subject', label: 'Subject', type: 'text', required: true },
          ],
        })
        .expect(201)
    ).body.id as string;
    await letter('all', 'رسالة أحمد', 'مدرسة النور', 'إيجار');
    await letter('wrongSubject', 'رسالة أحمد', 'مدرسة النور', 'عقد');
    await letter('wrongSender', 'رسالة أحمد', 'شركة', 'إيجار');
    await letter('wrongName', 'رسالة سالم', 'مدرسة النور', 'إيجار');
    await letter('partner', 'Letter five', 'أحمد وشركاه', 'x');

    const otherWs = await workspace(ctx, other, 'Arabic');
    await createRecord(ctx, other, otherWs, {
      name: 'أحمد السري',
      metadata: { supplier: 'أحمد السري', amount: 1 },
    });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  const invoices = () => `contentTypeId=${ws.typeId}`;

  it('finds every spelling of Ahmad with q=احمد', async () => {
    expect(await names(admin, `${invoices()}&q=${enc('احمد')}`)).toEqual(
      ['احمد', 'أحمد', 'إحمد', 'آحمد', HARAKAT_AHMAD].sort(),
    );
    for (const q of ['أحمد', 'إحمد', HARAKAT_AHMAD, 'احـــمد']) {
      expect((await list(admin, `${invoices()}&q=${enc(q)}`)).total).toBe(5);
    }
  });

  it('folds teh marbuta and alef maksura both ways', async () => {
    expect(await names(admin, `${invoices()}&q=${enc('مدرسه')}`)).toEqual(['مدرسة النور']);
    expect(await names(admin, `${invoices()}&q=${enc('مدرسة')}`)).toEqual(['مدرسة النور']);
    const hospitals = ['مستشفى المدينة', 'مستشفي الأمل'].sort();
    expect(await names(admin, `${invoices()}&q=${enc('مستشفى')}`)).toEqual(hospitals);
    expect(await names(admin, `${invoices()}&q=${enc('مستشفي')}`)).toEqual(hospitals);
  });

  it('folds Arabic-Indic digits both ways', async () => {
    const both = ['Invoice 123', 'فاتورة ١٢٣'].sort();
    expect(await names(admin, `${invoices()}&q=${enc('١٢٣')}`)).toEqual(both);
    expect(await names(admin, `${invoices()}&q=123`)).toEqual(both);
  });

  it('keeps English search as it was', async () => {
    expect(await names(admin, 'q=QUARTER')).toEqual(['Quarterly overview']);
    expect(await names(admin, 'q=invoice')).toEqual(['Invoice 123']);
  });

  it('matches regex metacharacters literally, never answering 500', async () => {
    for (const q of ['(', ')', '[', ']', 'a+b', '\\', '(q3)']) {
      expect(await names(admin, `q=${enc(q)}`)).toEqual([REGEX_NAME]);
    }
    for (const q of ['|', '{', '}', '?', '$', '^', 'a|b']) {
      expect((await list(admin, `q=${enc(q)}`)).total).toBe(0);
    }
    expect((await list(admin, `q=${enc('*')}`)).total).toBe(0);
    expect((await list(admin, `q=${enc('.*')}`)).total).toBe(0);
    expect((await list(admin, `q=${enc('.')}`)).total).toBe(0);
  });

  it('treats a query that folds to nothing as no query', async () => {
    const all = (await list(admin, '')).total;
    expect((await list(admin, `q=${enc('ـــ')}`)).total).toBe(all);
    expect((await list(admin, `q=${enc('َُ')}`)).total).toBe(all);
  });

  describe('control characters and length', () => {
    let legacyId: string;

    beforeAll(async () => {
      legacyId = (await createRecord(ctx, admin, ws, { name: 'Legacy a\tb' })).id;
      await makeLegacy(ctx, legacyId);
    });

    it('refuses control characters in q and meta.* with 400, with legacy records present', async () => {
      expect(await storedKeys(ctx, legacyId)).toBeUndefined();
      for (const url of [
        '/api/v1/records?q=a%00b',
        '/api/v1/records?q=a%01b',
        '/api/v1/records?q=a%7Fb',
        '/api/v1/records?q=a%C2%85b',
        '/api/v1/records/export?q=a%00b',
        `/api/v1/records?contentTypeId=${ws.typeId}&meta.supplier=a%00b`,
        '/api/v1/records?meta.supplier=a%00b',
        '/api/v1/records/export?meta.supplier=a%1Bb',
      ]) {
        const res = await as(ctx, admin).get(url).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      await as(ctx, admin).get('/api/v1/records?q=a%09b').expect(200);
    });

    it('refuses a meta.* value over 200 characters', async () => {
      await as(ctx, admin)
        .get(`/api/v1/records?meta.supplier=${'x'.repeat(200)}`)
        .expect(200);
      const res = await as(ctx, admin)
        .get(`/api/v1/records?meta.supplier=${'x'.repeat(201)}`)
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses saved-search criteria with a control character', async () => {
      for (const criteria of [{ q: 'a\u0000b' }, { metaKey: 'supplier', metaValue: 'a\u0000b' }]) {
        const res = await as(ctx, admin)
          .post('/api/v1/saved-searches')
          .send({ name: 'Bad', criteria })
          .expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  it("never shows another tenant's records, in the list or the export", async () => {
    expect((await list(admin, `q=${enc('احمد السري')}`)).total).toBe(0);
    const exported = await as(ctx, admin)
      .get(`/api/v1/records/export?q=${enc('احمد السري')}`)
      .expect(200);
    expect(exported.headers['x-export-count']).toBe('0');
    expect(await names(other, `q=${enc('احمد')}`)).toEqual(['أحمد السري']);
    expect(await names(other, `q=${enc('مدرسه')}`)).toEqual([]);
  });

  it('applies q and every meta.* filter together', async () => {
    const res = await list(
      admin,
      `contentTypeId=${letterTypeId}&q=${enc('احمد')}&meta.sender=${enc('مدرسه')}&meta.subject=${enc('ايجار')}`,
    );
    expect(res.items.map((r) => r.id)).toEqual([letters['all']]);
    expect((await list(admin, `contentTypeId=${letterTypeId}&q=${enc('احمد')}`)).total).toBe(4);
    expect(
      (await list(admin, `contentTypeId=${letterTypeId}&meta.sender=${enc('مدرسه')}`)).total,
    ).toBe(3);
    expect(
      (await list(admin, `contentTypeId=${letterTypeId}&meta.subject=${enc('ايجار')}`)).total,
    ).toBe(3);
  });

  it('exports what the list shows and audits the raw q; saved searches replay', async () => {
    const listed = await list(admin, `q=${enc(HARAKAT_AHMAD)}`);
    const exported = await as(ctx, admin)
      .get(`/api/v1/records/export?q=${enc(HARAKAT_AHMAD)}`)
      .expect(200);
    expect(exported.headers['x-export-count']).toBe(String(listed.total));
    const audit = await as(ctx, admin).get('/api/v1/audit?action=RECORDS_EXPORTED').expect(200);
    expect(audit.body.items[0].context.filters.q).toBe(HARAKAT_AHMAD);

    const saved = await as(ctx, admin)
      .post('/api/v1/saved-searches')
      .send({ name: 'Ahmad', criteria: { q: 'أحمد' } })
      .expect(201);
    expect(saved.body.criteria.q).toBe('أحمد');
    const replayed = await names(admin, `${invoices()}&q=${enc(saved.body.criteria.q as string)}`);
    expect(replayed).toContain('احمد');

    const byMeta = await as(ctx, admin)
      .post('/api/v1/saved-searches')
      .send({
        name: 'School letters',
        criteria: { contentTypeId: letterTypeId, metaKey: 'sender', metaValue: 'مدرسه' },
      })
      .expect(201);
    const { contentTypeId, metaKey, metaValue } = byMeta.body.criteria as Record<string, string>;
    const found = await list(
      admin,
      `contentTypeId=${contentTypeId}&meta.${metaKey}=${enc(metaValue)}`,
    );
    expect(found.items.map((r) => r.id).sort()).toEqual(
      [letters['all'], letters['wrongSubject'], letters['wrongName']].sort(),
    );
  });

  it('folds meta.* text filters only with a content type; exact types stay exact', async () => {
    expect(
      (await list(admin, `contentTypeId=${letterTypeId}&meta.sender=${enc('احمد')}`)).items.map(
        (r) => r.id,
      ),
    ).toEqual([letters['partner']]);
    expect((await list(admin, `meta.sender=${enc('احمد')}`)).total).toBe(0);
    expect((await list(admin, `meta.sender=${enc('أحمد وشركاه')}`)).items.map((r) => r.id)).toEqual(
      [letters['partner']],
    );
    expect((await list(admin, `${invoices()}&meta.amount=5`)).total).toBeGreaterThan(0);
    expect((await list(admin, `${invoices()}&meta.amount=50`)).total).toBe(0);
    expect((await list(admin, `${invoices()}&meta.status=Ope`)).total).toBe(0);
  });

  describe('write paths', () => {
    it('stores every key on create', async () => {
      const { id } = await createRecord(ctx, admin, ws, {
        name: 'مدرسة الأمل',
        metadata: { supplier: 'مؤسسة أحمد', amount: 7 },
      });
      const keys = await storedKeys(ctx, id);
      expect(keys).toMatchObject({ v: 1, mv: 1, meta: { supplier: 'موسسه احمد' } });
      expect(keys?.text).toContain('مدرسه الامل');
      expect(keys?.content).toBeUndefined();
      expect(keys?.cv).toBeUndefined();
    });

    it('writes only the text key on rename, retag and bulk retag', async () => {
      const { id } = await createRecord(ctx, admin, ws, { name: 'Rename me' });
      await makeLegacy(ctx, id);
      await as(ctx, admin).patch(`/api/v1/records/${id}`).send({ name: 'أحمد الجديد' }).expect(200);
      let keys = await storedKeys(ctx, id);
      expect(keys).toEqual({ text: expect.stringContaining('احمد الجديد'), v: 1 });

      await makeLegacy(ctx, id);
      await as(ctx, admin)
        .put(`/api/v1/records/${id}/tags`)
        .send({ tags: ['q3'] })
        .expect(200);
      keys = await storedKeys(ctx, id);
      expect(keys).toEqual({ text: expect.stringContaining('q3'), v: 1 });

      await makeLegacy(ctx, id);
      await as(ctx, admin)
        .post('/api/v1/bulk/records/tags')
        .send({ ids: [id], add: ['urgent'] })
        .expect(200);
      keys = await storedKeys(ctx, id);
      expect(keys).toEqual({ text: expect.stringContaining('urgent'), v: 1 });
    });

    it('writes the text and metadata keys on a new version and a restore', async () => {
      const { id } = await createRecord(ctx, admin, ws, {
        name: 'Versioned',
        metadata: { supplier: 'مدرسة', amount: 1 },
      });
      await makeLegacy(ctx, id);
      await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'مستشفى', amount: 2 }, comment: 'v2' })
        .expect(201);
      let keys = await storedKeys(ctx, id);
      expect(keys).toEqual({
        text: expect.stringContaining('مستشفي'),
        v: 1,
        meta: { supplier: 'مستشفي', status: 'open' },
        mv: 1,
      });

      await makeLegacy(ctx, id);
      await as(ctx, admin).post(`/api/v1/records/${id}/versions/1/restore`).send({}).expect(201);
      keys = await storedKeys(ctx, id);
      expect(keys).toEqual({
        text: expect.stringContaining('مدرسه'),
        v: 1,
        meta: { supplier: 'مدرسه', status: 'open' },
        mv: 1,
      });
    });
  });

  it('keeps the metadata keys of a version committed while a rename was in flight', async () => {
    const { id } = await createRecord(ctx, admin, ws, {
      name: 'Race rename',
      metadata: { supplier: 'قديم', amount: 1 },
    });
    const records = ctx.app.get(RecordsRepository, { strict: false });
    const updateOne = records.updateOne.bind(records);
    const spy = vi.spyOn(records, 'updateOne').mockImplementationOnce(async (...args) => {
      await as(ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'مدرسة جديدة', amount: 2 }, comment: 'meanwhile' })
        .expect(201);
      return updateOne(...args);
    });
    try {
      await as(ctx, admin)
        .patch(`/api/v1/records/${id}`)
        .send({ name: 'Race renamed' })
        .expect(200);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const keys = await storedKeys(ctx, id);
    expect(keys?.meta).toEqual({ supplier: searchKey('مدرسة جديدة'), status: 'open' });
    expect(keys?.mv).toBe(1);
    expect(await names(admin, `${invoices()}&meta.supplier=${enc('مدرسه جديده')}`)).toEqual([
      'Race renamed',
    ]);
  });

  it('never returns the search keys in any payload', async () => {
    const key = searchKey('مدرسة النور');
    const id = ids['مدرسة النور'];
    const payloads: unknown[] = [
      (
        await as(ctx, admin)
          .get(`/api/v1/records?q=${enc('مدرسه')}`)
          .expect(200)
      ).body,
      (await as(ctx, admin).get(`/api/v1/records/${id}`).expect(200)).body,
      (await as(ctx, admin).get(`/api/v1/records/${id}/versions`).expect(200)).body,
      (
        await as(ctx, admin)
          .patch(`/api/v1/records/${id}`)
          .send({ name: 'مدرسة النور' })
          .expect(200)
      ).body,
      (await as(ctx, admin).get('/api/v1/audit').expect(200)).body,
    ];
    const csv = await as(ctx, admin)
      .get(`/api/v1/records/export?q=${enc('مدرسه')}`)
      .expect(200);
    expect(Number(csv.headers['x-export-count'])).toBeGreaterThan(0);
    const trashed = (await createRecord(ctx, admin, ws, { name: 'مدرسة للحذف' })).id;
    await as(ctx, admin).delete(`/api/v1/records/${trashed}`).expect(204);
    payloads.push((await as(ctx, admin).get('/api/v1/trash').expect(200)).body);
    for (const body of payloads) {
      const json = JSON.stringify(body);
      expect(json).not.toContain('"search":');
      expect(json).not.toContain(key);
      expect(json).not.toContain(searchKey('مدرسة للحذف'));
    }
    expect(csv.text).not.toContain(key);
  });
});

describe('text-search throttle (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;

  beforeAll(async () => {
    ctx = await createTestApp([], { SEARCH_RATE_LIMIT: '3', SEARCH_EXPORT_RATE_LIMIT: '2' });
    admin = await signUp(ctx, { tenantName: 'Throttle Co' });
    member = await addMember(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('limits text searches per user, and leaves plain lists alone', async () => {
    for (let i = 0; i < 3; i += 1) await as(ctx, admin).get('/api/v1/records?q=a').expect(200);
    const blocked = await as(ctx, admin).get('/api/v1/records?q=a').expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    await as(ctx, admin).get('/api/v1/records?meta.x=1').expect(429);
    for (let i = 0; i < 5; i += 1) await as(ctx, admin).get('/api/v1/records').expect(200);
    await as(ctx, admin).get('/api/v1/records?q=').expect(200);
    await as(ctx, member).get('/api/v1/records?meta.x=1').expect(200);
  });

  it('limits text-search exports separately', async () => {
    for (let i = 0; i < 2; i += 1) {
      await as(ctx, member).get('/api/v1/records/export?q=a').expect(200);
    }
    const blocked = await as(ctx, member).get('/api/v1/records/export?q=a').expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    await as(ctx, member).get('/api/v1/records/export').expect(200);
  });
});

describe('Arabic-aware search inside the access scope', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Scope Co' });
    member = await addMember(ctx, admin);
    const granted = await workspace(ctx, admin, 'Granted');
    const hidden = await workspace(ctx, admin, 'Hidden');
    await createRecord(ctx, admin, granted, { name: 'أحمد المسموح' });
    await createRecord(ctx, admin, hidden, { name: 'إحمد المخفي' });
    await grantAccess(ctx, admin, {
      userId: member.userId,
      targetType: 'folder',
      targetId: granted.folderId,
      level: 'view',
    });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it("returns a member's matches only from granted folders, and an admin's from all", async () => {
    const find = async (actor: Actor) =>
      (
        await as(ctx, actor)
          .get(`/api/v1/records?q=${enc('احمد')}`)
          .expect(200)
      ).body as {
        items: Listed[];
        total: number;
      };
    const memberHits = await find(member);
    expect(memberHits.items.map((r) => r.name)).toEqual(['أحمد المسموح']);
    expect(memberHits.total).toBe(1);
    const adminHits = await find(admin);
    expect(adminHits.items.map((r) => r.name).sort()).toEqual(['أحمد المسموح', 'إحمد المخفي']);
    expect(adminHits.total).toBe(2);

    const memberExport = await as(ctx, member)
      .get(`/api/v1/records/export?q=${enc('احمد')}`)
      .expect(200);
    expect(memberExport.headers['x-export-count']).toBe('1');
    expect(memberExport.text).not.toContain('المخفي');
    const adminExport = await as(ctx, admin)
      .get(`/api/v1/records/export?q=${enc('احمد')}`)
      .expect(200);
    expect(adminExport.headers['x-export-count']).toBe('2');
  });
});
