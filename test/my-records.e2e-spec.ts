import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RecordFavorite, RecordViewEntry } from '../src/my-records/favorite.schema.js';
import { VIEWS_KEPT } from '../src/my-records/my-records.service.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe('favorites and recently viewed (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Starred Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('adds and removes favorites per user, idempotently, newest first', async () => {
    const a = await createRecord(ctx, admin, ws, { name: 'Fav A' });
    const b = await createRecord(ctx, admin, ws, { name: 'Fav B' });
    await as(ctx, member).put(`/api/v1/records/${a.id}/favorite`).expect(204);
    await as(ctx, member).put(`/api/v1/records/${b.id}/favorite`).expect(204);
    await as(ctx, member).put(`/api/v1/records/${b.id}/favorite`).expect(204);
    const mine = await as(ctx, member).get('/api/v1/me/favorites').expect(200);
    expect(ids(mine.body)).toEqual([b.id, a.id]);
    expect(mine.body[0]).toMatchObject({ name: 'Fav B', folderName: 'Invoices' });
    const flag = await as(ctx, member).get(`/api/v1/records/${a.id}/favorite`).expect(200);
    expect(flag.body).toEqual({ favorite: true });

    const adminFavorites = await as(ctx, admin).get('/api/v1/me/favorites').expect(200);
    expect(adminFavorites.body).toEqual([]);

    await as(ctx, member).delete(`/api/v1/records/${a.id}/favorite`).expect(204);
    await as(ctx, member).delete(`/api/v1/records/${a.id}/favorite`).expect(204);
    const after = await as(ctx, member).get('/api/v1/me/favorites').expect(200);
    expect(ids(after.body)).toEqual([b.id]);
  });

  it('keeps one favorite under parallel requests', async () => {
    const { id } = await createRecord(ctx, admin, ws);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => as(ctx, admin).put(`/api/v1/records/${id}/favorite`)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(204));
    const model = ctx.app.get<Model<RecordFavorite>>(getModelToken(RecordFavorite.name));
    expect(await model.countDocuments({ recordId: new Types.ObjectId(id) })).toBe(1);
  });

  it('lists recently viewed records, most recent first, one entry per record', async () => {
    const a = await createRecord(ctx, admin, ws, { name: 'Seen A' });
    const b = await createRecord(ctx, admin, ws, { name: 'Seen B' });
    await as(ctx, member).post(`/api/v1/records/${a.id}/views`).expect(204);
    await as(ctx, member).post(`/api/v1/records/${b.id}/views`).expect(204);
    await Promise.all([
      as(ctx, member).post(`/api/v1/records/${a.id}/views`).expect(204),
      as(ctx, member).post(`/api/v1/records/${a.id}/views`).expect(204),
    ]);
    const recent = await as(ctx, member).get('/api/v1/me/recent').expect(200);
    expect(recent.body.map((r: { record: { id: string } }) => r.record.id)).toEqual([a.id, b.id]);
    expect(Date.parse(recent.body[0].viewedAt)).toBeGreaterThan(0);
    const adminRecent = await as(ctx, admin).get('/api/v1/me/recent').expect(200);
    expect(adminRecent.body).toEqual([]);
  });

  it('keeps only the newest views per user', async () => {
    const viewer = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, viewer);
    const viewModel = ctx.app.get<Model<RecordViewEntry>>(getModelToken(RecordViewEntry.name));
    const old = Date.now() - 86_400_000;
    await viewModel.insertMany(
      Array.from({ length: VIEWS_KEPT + 5 }, (_, i) => ({
        tenantId: new Types.ObjectId(admin.tenantId),
        userId: new Types.ObjectId(viewer.userId),
        recordId: new Types.ObjectId(),
        viewedAt: new Date(old + i * 1000),
      })),
    );
    const { id } = await createRecord(ctx, admin, ws, { name: 'Fresh view' });
    await as(ctx, viewer).post(`/api/v1/records/${id}/views`).expect(204);
    const userId = new Types.ObjectId(viewer.userId);
    expect(await viewModel.countDocuments({ userId })).toBe(VIEWS_KEPT);
    expect(await viewModel.countDocuments({ userId, recordId: new Types.ObjectId(id) })).toBe(1);
    const others = await viewModel.countDocuments({ userId: new Types.ObjectId(member.userId) });
    expect(others).toBe(2);
  });

  it('hides trashed records and forgets purged ones', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Doomed favorite' });
    await as(ctx, admin).put(`/api/v1/records/${id}/favorite`).expect(204);
    await as(ctx, admin).post(`/api/v1/records/${id}/views`).expect(204);
    await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    const favorites = await as(ctx, admin).get('/api/v1/me/favorites').expect(200);
    expect(ids(favorites.body)).not.toContain(id);
    const recent = await as(ctx, admin).get('/api/v1/me/recent').expect(200);
    expect(recent.body.map((r: { record: { id: string } }) => r.record.id)).not.toContain(id);
    await as(ctx, admin).put(`/api/v1/records/${id}/favorite`).expect(404);
    await as(ctx, admin).post(`/api/v1/records/${id}/views`).expect(404);

    await as(ctx, admin).post(`/api/v1/trash/records/${id}/restore`).expect(200);
    const back = await as(ctx, admin).get('/api/v1/me/favorites').expect(200);
    expect(ids(back.body)).toContain(id);

    await as(ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/trash/records/${id}`).expect(200);
    const recordId = new Types.ObjectId(id);
    const favoriteModel = ctx.app.get<Model<RecordFavorite>>(getModelToken(RecordFavorite.name));
    const viewModel = ctx.app.get<Model<RecordViewEntry>>(getModelToken(RecordViewEntry.name));
    expect(await favoriteModel.countDocuments({ recordId })).toBe(0);
    expect(await viewModel.countDocuments({ recordId })).toBe(0);
  });

  it('isolates favorites and recents between tenants', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Private' });
    await as(ctx, admin).put(`/api/v1/records/${id}/favorite`).expect(204);
    await as(ctx, other).put(`/api/v1/records/${id}/favorite`).expect(404);
    await as(ctx, other).delete(`/api/v1/records/${id}/favorite`).expect(404);
    await as(ctx, other).get(`/api/v1/records/${id}/favorite`).expect(404);
    await as(ctx, other).post(`/api/v1/records/${id}/views`).expect(404);
    expect((await as(ctx, other).get('/api/v1/me/favorites').expect(200)).body).toEqual([]);
    expect((await as(ctx, other).get('/api/v1/me/recent').expect(200)).body).toEqual([]);
    await ctx.http().get('/api/v1/me/favorites').expect(401);
    await ctx.http().put(`/api/v1/records/${id}/favorite`).expect(401);
  });
});
