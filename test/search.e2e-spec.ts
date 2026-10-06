import { as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('search (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let other: Actor;
  let ws: Workspace;
  let archiveId: string;
  let memoTypeId: string;

  const names = (res: { body: { items: Array<{ name: string }> } }) =>
    res.body.items.map((item) => item.name).sort();

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Search Co' });
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin, 'Finance');
    archiveId = (
      await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Archive', parentId: ws.folderId })
        .expect(201)
    ).body.id;
    memoTypeId = (
      await as(ctx, admin)
        .post('/api/v1/content-types')
        .send({
          name: 'Memo',
          fields: [{ key: 'body', label: 'Body', type: 'textarea', required: true }],
        })
        .expect(201)
    ).body.id;
    await createRecord(ctx, admin, ws, {
      name: 'Quarterly invoice',
      metadata: { supplier: 'Globex', amount: 1500, status: 'Open', dueDate: '2026-10-01' },
      file: { content: 'q', name: 'quarterly-scan.pdf', type: 'application/pdf' },
    });
    await createRecord(
      ctx,
      admin,
      { ...ws, folderId: archiveId },
      {
        name: 'Old invoice',
        metadata: { supplier: 'Initech', amount: 200, status: 'Paid' },
      },
    );
    await as(ctx, admin)
      .post('/api/v1/records')
      .send({
        name: 'Team memo',
        contentTypeId: memoTypeId,
        folderId: ws.rootId,
        metadata: { body: 'Remember the Globex renewal' },
      })
      .expect(201);
    const otherWs = await workspace(ctx, other, 'Finance');
    await createRecord(ctx, other, otherWs, {
      name: 'Globex secret invoice',
      metadata: { supplier: 'Globex', amount: 1 },
    });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('matches partial words in names, metadata and file names, case-insensitively', async () => {
    expect(names(await as(ctx, admin).get('/api/v1/records?q=QUARTER').expect(200))).toEqual([
      'Quarterly invoice',
    ]);
    expect(names(await as(ctx, admin).get('/api/v1/records?q=globex').expect(200))).toEqual([
      'Quarterly invoice',
      'Team memo',
    ]);
    expect(names(await as(ctx, admin).get('/api/v1/records?q=scan.pdf').expect(200))).toEqual([
      'Quarterly invoice',
    ]);
    expect(
      (await as(ctx, admin).get('/api/v1/records?q=nothing-like-this').expect(200)).body.total,
    ).toBe(0);
    expect((await as(ctx, admin).get('/api/v1/records?q=.*').expect(200)).body.total).toBe(0);
  });

  it('filters by content type, folder (with and without subfolders) and metadata values', async () => {
    expect(
      names(await as(ctx, admin).get(`/api/v1/records?contentTypeId=${ws.typeId}`).expect(200)),
    ).toEqual(['Old invoice', 'Quarterly invoice']);
    expect(
      names(
        await as(ctx, admin)
          .get(`/api/v1/records?folderId=${ws.folderId}&includeSubfolders=true`)
          .expect(200),
      ),
    ).toEqual(['Old invoice', 'Quarterly invoice']);
    expect(
      names(await as(ctx, admin).get(`/api/v1/records?folderId=${ws.folderId}`).expect(200)),
    ).toEqual(['Quarterly invoice']);
    expect(names(await as(ctx, admin).get('/api/v1/records?meta.status=Paid').expect(200))).toEqual(
      ['Old invoice'],
    );
    expect(names(await as(ctx, admin).get('/api/v1/records?meta.amount=1500').expect(200))).toEqual(
      ['Quarterly invoice'],
    );
    expect(
      names(
        await as(ctx, admin)
          .get(`/api/v1/records?contentTypeId=${ws.typeId}&meta.supplier=glob`)
          .expect(200),
      ),
    ).toEqual(['Quarterly invoice']);
    expect(
      names(
        await as(ctx, admin)
          .get(
            `/api/v1/records?q=invoice&folderId=${ws.folderId}&includeSubfolders=true&meta.status=Open`,
          )
          .expect(200),
      ),
    ).toEqual(['Quarterly invoice']);
  });

  it('filters by date range and sorts', async () => {
    const future = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const past = encodeURIComponent(new Date(Date.now() - 60 * 60_000).toISOString());
    expect(
      (await as(ctx, admin).get(`/api/v1/records?from=${future}`).expect(200)).body.total,
    ).toBe(0);
    expect(
      (await as(ctx, admin).get(`/api/v1/records?from=${past}&dateField=createdAt`).expect(200))
        .body.total,
    ).toBe(3);
    expect((await as(ctx, admin).get(`/api/v1/records?to=${past}`).expect(200)).body.total).toBe(0);
    const sorted = await as(ctx, admin).get('/api/v1/records?sort=name&order=asc').expect(200);
    expect(sorted.body.items.map((r: { name: string }) => r.name)).toEqual([
      'Old invoice',
      'Quarterly invoice',
      'Team memo',
    ]);
  });

  it('paginates', async () => {
    const page = await as(ctx, admin)
      .get('/api/v1/records?pageSize=2&page=2&sort=name&order=asc')
      .expect(200);
    expect(page.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page.body.items.map((r: { name: string }) => r.name)).toEqual(['Team memo']);
  });

  it('rejects metadata filter keys that could inject query operators', async () => {
    const res = await as(ctx, admin).get('/api/v1/records?meta.$where=1').expect(400);
    expect(res.body.code).toBe('INVALID_FILTER');
  });

  it("never returns another tenant's records and 404s on their folders", async () => {
    expect((await as(ctx, admin).get('/api/v1/records?q=secret').expect(200)).body.total).toBe(0);
    expect(names(await as(ctx, other).get('/api/v1/records').expect(200))).toEqual([
      'Globex secret invoice',
    ]);
    await as(ctx, other).get(`/api/v1/records?folderId=${ws.folderId}`).expect(404);
    expect(
      (await as(ctx, other).get(`/api/v1/records?contentTypeId=${ws.typeId}`).expect(200)).body
        .total,
    ).toBe(0);
  });
});
