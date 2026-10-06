import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const criteria = {
  q: 'globex',
  contentTypeId: '64b000000000000000000001',
  metaKey: 'status',
  metaValue: 'Open',
  folder: { id: '64b000000000000000000002', path: 'Repository / Finance' },
  includeSubfolders: true,
  dateField: 'updatedAt',
  from: '2026-01-01',
  to: '2026-12-31',
  tags: ['urgent'],
};

describe('saved searches (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Search Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('saves, lists by name and deletes a user’s own searches', async () => {
    const saved = await as(ctx, member)
      .post('/api/v1/saved-searches')
      .send({ name: 'Open Globex invoices', criteria })
      .expect(201);
    expect(saved.body).toMatchObject({ name: 'Open Globex invoices', criteria });
    await as(ctx, member)
      .post('/api/v1/saved-searches')
      .send({ name: 'All urgent', criteria: { tags: ['urgent'] } })
      .expect(201);
    const list = await as(ctx, member).get('/api/v1/saved-searches').expect(200);
    expect(list.body.map((s: { name: string }) => s.name)).toEqual([
      'All urgent',
      'Open Globex invoices',
    ]);
    expect((await as(ctx, admin).get('/api/v1/saved-searches').expect(200)).body).toEqual([]);

    await as(ctx, admin).delete(`/api/v1/saved-searches/${saved.body.id}`).expect(404);
    await as(ctx, member).delete(`/api/v1/saved-searches/${saved.body.id}`).expect(204);
    await as(ctx, member).delete(`/api/v1/saved-searches/${saved.body.id}`).expect(404);
    await as(ctx, member).delete('/api/v1/saved-searches/not-an-id').expect(404);
  });

  it('validates names and criteria', async () => {
    const post = (body: object) => as(ctx, admin).post('/api/v1/saved-searches').send(body);
    await post({ name: '', criteria: {} }).expect(400);
    await post({ name: 'x'.repeat(81), criteria: {} }).expect(400);
    await post({ name: 'Bad date', criteria: { from: 'yesterday' } }).expect(400);
    await post({ name: 'Unknown key', criteria: { $where: '1' } }).expect(400);
    await post({ name: 'Bad tag', criteria: { tags: ['no/slash'] } }).expect(400);
    await post({ name: 'Backwards', criteria: { from: '2026-05-01', to: '2026-04-01' } }).expect(
      400,
    );
    await post({ name: 'Bad type', criteria: { contentTypeId: 'invoice' } }).expect(400);
    await post({ name: 'Bad folder', criteria: { folder: { id: '../x', path: 'x' } } }).expect(400);
    await post({ name: 'Empty is fine', criteria: {} }).expect(201);
  });

  it('rejects a duplicate name, also when two saves race', async () => {
    const save = () =>
      as(ctx, admin).post('/api/v1/saved-searches').send({ name: 'Racing', criteria: {} });
    const results = await Promise.all([save(), save(), save()]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409, 409]);
    const conflict = results.find((r) => r.status === 409);
    expect(conflict?.body.code).toBe('NAME_TAKEN');
    const list = await as(ctx, admin).get('/api/v1/saved-searches').expect(200);
    expect(list.body.filter((s: { name: string }) => s.name === 'Racing')).toHaveLength(1);
  });

  it('isolates saved searches between tenants', async () => {
    const saved = await as(ctx, admin)
      .post('/api/v1/saved-searches')
      .send({ name: 'Tenant secret', criteria: { q: 'secret' } })
      .expect(201);
    expect((await as(ctx, other).get('/api/v1/saved-searches').expect(200)).body).toEqual([]);
    await as(ctx, other).delete(`/api/v1/saved-searches/${saved.body.id}`).expect(404);
    const mine = await as(ctx, admin).get('/api/v1/saved-searches').expect(200);
    expect(mine.body.map((s: { id: string }) => s.id)).toContain(saved.body.id);
    await ctx.http().get('/api/v1/saved-searches').expect(401);
  });
});
