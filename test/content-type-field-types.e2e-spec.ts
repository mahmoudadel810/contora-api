import { as, signUp, type Actor } from './helpers/actors.js';
import { workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const VISIT_TYPE = {
  name: 'Site visit',
  fields: [
    { key: 'site', label: 'Site', type: 'text', required: true },
    { key: 'contact', label: 'Contact phone', type: 'phone', required: false },
    { key: 'visitedAt', label: 'Visited at', type: 'datetime', required: false },
    { key: 'arrival', label: 'Arrival', type: 'time', required: false, defaultValue: '09:00' },
    { key: 'cost', label: 'Cost', type: 'currency', required: false, currency: 'EUR', min: 0 },
    { key: 'done', label: 'Completion', type: 'percentage', required: false, defaultValue: 0 },
    {
      key: 'outcome',
      label: 'Outcome',
      type: 'radio',
      required: false,
      options: ['Resolved', 'Follow-up', 'Escalated'],
      defaultValue: 'Resolved',
    },
    {
      key: 'checks',
      label: 'Checks',
      type: 'checkboxes',
      required: false,
      options: ['Safety', 'Equipment', 'Cleanliness'],
      defaultValue: ['Safety'],
    },
  ],
};

const FULL = {
  site: 'Harbour depot',
  contact: '+49 30 1234-567',
  visitedAt: '2026-09-30T08:15Z',
  arrival: '08:10',
  cost: 1250.5,
  done: 75.25,
  outcome: 'Follow-up',
  checks: ['Equipment', 'Cleanliness'],
};

describe('content type builder field types (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let other: Actor;
  let ws: Workspace;
  let typeId: string;

  const create = (metadata: Record<string, unknown>, name = 'Visit') =>
    as(ctx, admin)
      .post('/api/v1/records')
      .send({ name, contentTypeId: typeId, folderId: ws.folderId, metadata });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Visits Co', displayName: 'Vera Admin' });
    other = await signUp(ctx, { tenantName: 'Elsewhere Co' });
    ws = await workspace(ctx, admin);
    const created = await as(ctx, admin).post('/api/v1/content-types').send(VISIT_TYPE).expect(201);
    typeId = created.body.id;
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('defines a type with all seven new field types and keeps their settings', async () => {
    const type = await as(ctx, admin).get(`/api/v1/content-types/${typeId}`).expect(200);
    expect(type.body.fields.map((f: { type: string }) => f.type)).toEqual([
      'text',
      'phone',
      'datetime',
      'time',
      'currency',
      'percentage',
      'radio',
      'checkboxes',
    ]);
    expect(type.body.fields[4]).toMatchObject({ currency: 'EUR', min: 0 });
  });

  it('refuses definitions that cannot work', async () => {
    const define = (field: Record<string, unknown>) =>
      as(ctx, admin)
        .post('/api/v1/content-types')
        .send({ name: `Bad ${Math.random()}`, fields: [{ key: 'f', label: 'F', ...field }] });
    const pathsOf = async (field: Record<string, unknown>) =>
      (await define(field).expect(400)).body.details.map((d: { path: string }) => d.path);
    expect(await pathsOf({ type: 'currency' })).toEqual(['fields.0.currency']);
    expect(await pathsOf({ type: 'number', currency: 'EUR' })).toEqual(['fields.0.currency']);
    expect(await pathsOf({ type: 'radio' })).toEqual(['fields.0.options']);
    expect(await pathsOf({ type: 'checkboxes' })).toEqual(['fields.0.options']);
    expect(await pathsOf({ type: 'time', min: 1 })).toEqual(['fields.0.min']);
    expect(await pathsOf({ type: 'text', key: 'valueOf' })).toEqual(['fields.0.key']);
    expect(await pathsOf({ type: 'percentage', defaultValue: 101 })).toEqual([
      'fields.0.defaultValue',
    ]);
  });

  it('stores valid values as given and applies the defaults', async () => {
    const full = await create(FULL, 'Harbour visit').expect(201);
    const canonical = { ...FULL, visitedAt: '2026-09-30T08:15:00.000Z' };
    expect(full.body.metadata).toEqual(canonical);
    const read = await as(ctx, admin).get(`/api/v1/records/${full.body.id}`).expect(200);
    expect(read.body.record.metadata).toEqual(canonical);
    const defaulted = await create({ site: 'Depot north' }, 'North visit').expect(201);
    expect(defaulted.body.metadata).toEqual({
      site: 'Depot north',
      arrival: '09:00',
      done: 0,
      outcome: 'Resolved',
      checks: ['Safety'],
    });
  });

  it('rejects invalid values on create and on a new version, with VALIDATION_FAILED', async () => {
    const invalid: Record<string, unknown> = {
      contact: 'call reception',
      visitedAt: '2026-02-30T10:00Z',
      arrival: '24:00',
      cost: 10.005,
      done: 120,
      outcome: 'Unknown',
      checks: ['Safety', 'Safety'],
    };
    const rejected = await create({ site: 'Bad', ...invalid }).expect(400);
    expect(rejected.body.code).toBe('VALIDATION_FAILED');
    expect(rejected.body.details.map((d: { path: string }) => d.path).sort()).toEqual(
      Object.keys(invalid)
        .map((key) => `metadata.${key}`)
        .sort(),
    );

    const record = await create({ site: 'Updated' }, 'Updated visit').expect(201);
    for (const [key, value] of Object.entries(invalid)) {
      const response = await as(ctx, admin)
        .post(`/api/v1/records/${record.body.id}/versions`)
        .send({ metadata: { site: 'Updated', [key]: value } })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details.map((d: { path: string }) => d.path)).toEqual([
        `metadata.${key}`,
      ]);
    }
    const next = await as(ctx, admin)
      .post(`/api/v1/records/${record.body.id}/versions`)
      .send({
        metadata: {
          ...FULL,
          site: 'Updated',
          contact: '+1 555 0100',
          visitedAt: '2026-09-30T08:15:00Z',
          cost: 99.9,
          done: 10,
          checks: ['Safety'],
        },
      })
      .expect(201);
    expect(next.body.metadata).toMatchObject({ cost: 99.9, checks: ['Safety'] });
    const versions = await as(ctx, admin)
      .get(`/api/v1/records/${record.body.id}/versions`)
      .expect(200);
    expect(versions.body).toHaveLength(2);
  });

  it('finds records by phone, currency, percentage, radio and checkbox values', async () => {
    const names = async (query: string) =>
      (
        await as(ctx, admin).get(`/api/v1/records?contentTypeId=${typeId}&${query}`).expect(200)
      ).body.items
        .map((r: { name: string }) => r.name)
        .sort();
    expect(await names('meta.contact=1234')).toEqual(['Harbour visit']);
    expect(await names('meta.cost=1250.5')).toEqual(['Harbour visit']);
    expect(await names('meta.done=75.25')).toEqual(['Harbour visit']);
    expect(await names('meta.outcome=Follow-up')).toEqual(['Harbour visit', 'Updated visit']);
    expect(await names('meta.checks=Cleanliness')).toEqual(['Harbour visit']);
    for (const form of ['08:15Z', '08:15:00Z', '08:15:00.000Z']) {
      expect(await names(`meta.visitedAt=2026-09-30T${form}`), form).toEqual([
        'Harbour visit',
        'Updated visit',
      ]);
    }
    expect(await names('meta.visitedAt=2026-02-30T08:15Z')).toEqual([]);
    expect(await names('meta.visitedAt=yesterday')).toEqual([]);
    expect(await names('q=1234-567')).toEqual(['Harbour visit']);
    expect(await names('q=cleanliness')).toEqual(['Harbour visit']);
    expect(await names('q=0100')).toEqual(['Updated visit']);
    expect(await names('q=escalated')).toEqual([]);
  });

  it('exports the values to CSV, currency as the bare number with the code in the header', async () => {
    const csv = await as(ctx, admin)
      .get(`/api/v1/records/export?contentTypeId=${typeId}&sort=name&order=asc`)
      .expect(200);
    const lines = csv.text.trim().split('\r\n');
    expect(
      lines[0].endsWith(
        ',Site,Contact phone,Visited at,Arrival,Cost (EUR),Completion,Outcome,Checks',
      ),
    ).toBe(true);
    const harbour = lines.find((line) => line.startsWith('Harbour visit,'));
    expect(
      harbour?.endsWith(
        ",Harbour depot,'+49 30 1234-567,2026-09-30T08:15:00.000Z,08:10,1250.5,75.25,Follow-up,Equipment; Cleanliness",
      ),
    ).toBe(true);
  });

  it('round-trips a field labelled "Constructor" (key constructor2) through GET, CSV and search', async () => {
    const type = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({
        name: 'Builder notes',
        fields: [{ key: 'constructor2', label: 'Constructor', type: 'text', required: false }],
      })
      .expect(201);
    const typeOf = type.body.id as string;
    const make = (name: string, metadata: Record<string, unknown>) =>
      as(ctx, admin)
        .post('/api/v1/records')
        .send({ name, contentTypeId: typeOf, folderId: ws.folderId, metadata })
        .expect(201);
    const built = await make('Built by Bob', { constructor2: 'Bob the Builder' });
    await make('No builder', {});
    const read = await as(ctx, admin).get(`/api/v1/records/${built.body.id}`).expect(200);
    expect(read.body.record.metadata).toEqual({ constructor2: 'Bob the Builder' });

    const found = await as(ctx, admin)
      .get(`/api/v1/records?contentTypeId=${typeOf}&meta.constructor2=bob`)
      .expect(200);
    expect(found.body.items.map((r: { name: string }) => r.name)).toEqual(['Built by Bob']);

    const csv = await as(ctx, admin)
      .get(`/api/v1/records/export?contentTypeId=${typeOf}&sort=name&order=asc`)
      .expect(200);
    const [header, bob, none] = csv.text.trim().split('\r\n');
    expect(header.endsWith(',Constructor')).toBe(true);
    expect(bob.endsWith(',Bob the Builder')).toBe(true);
    expect(none.startsWith('No builder,')).toBe(true);
    expect(none.endsWith(',')).toBe(true);
  });

  it('keeps the type and its records invisible to another tenant', async () => {
    const record = await create(FULL, 'Private visit').expect(201);
    await as(ctx, other).get(`/api/v1/content-types/${typeId}`).expect(404);
    await as(ctx, other).get(`/api/v1/records/${record.body.id}`).expect(404);
    await as(ctx, other)
      .post('/api/v1/records')
      .send({ name: 'x', contentTypeId: typeId, folderId: ws.folderId, metadata: FULL })
      .expect(404);
    const listed = await as(ctx, other).get(`/api/v1/records?q=harbour`).expect(200);
    expect(listed.body.total).toBe(0);
  });
});
