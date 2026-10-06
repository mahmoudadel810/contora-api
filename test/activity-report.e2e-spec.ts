import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AuditEntry } from '../src/audit/audit-entry.schema.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('activity report (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;

  const backdate = async (actor: Actor, offsetDays: number, action: string, times = 1) => {
    const model = ctx.app.get<Model<AuditEntry>>(getModelToken(AuditEntry.name));
    await model.collection.insertMany(
      Array.from({ length: times }, () => ({
        tenantId: new Types.ObjectId(actor.tenantId),
        action,
        actor: {
          id: new Types.ObjectId(actor.userId),
          email: actor.email,
          displayName: actor.displayName,
        },
        resource: { type: 'record' },
        context: {},
        createdAt: new Date(`${day(offsetDays)}T12:00:00.000Z`),
      })),
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Report Co', displayName: 'Ada Admin' });
    member = await addMember(ctx, admin);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    await backdate(member, -2, 'RECORD_CREATED', 3);
    await backdate(admin, -40, 'RECORD_TRASHED');
    await backdate(other, -2, 'RECORD_CREATED', 5);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('covers the last 30 UTC days by default, day by day, for the caller tenant only', async () => {
    const res = await as(ctx, admin).get('/api/v1/audit/report').expect(200);
    expect(res.body.from).toBe(day(-29));
    expect(res.body.to).toBe(day(0));
    expect(res.body.perDay).toHaveLength(30);
    expect(res.body.perDay.find((d: { day: string }) => d.day === day(-2)).count).toBe(3);
    const recordCreated = res.body.byAction.find(
      (a: { action: string }) => a.action === 'RECORD_CREATED',
    );
    expect(recordCreated.count).toBe(3);
    expect(res.body.byAction.some((a: { action: string }) => a.action === 'RECORD_TRASHED')).toBe(
      false,
    );
    expect(res.body.topUsers[0]).toMatchObject({ id: member.userId, count: 4 });
    const sum = res.body.perDay.reduce((n: number, d: { count: number }) => n + d.count, 0);
    expect(sum).toBe(res.body.total);
  });

  it('honours an explicit range', async () => {
    const res = await as(ctx, admin)
      .get(`/api/v1/audit/report?from=${day(-41)}&to=${day(-39)}`)
      .expect(200);
    expect(res.body.perDay.map((d: { count: number }) => d.count)).toEqual([0, 1, 0]);
    expect(res.body.byAction).toEqual([{ action: 'RECORD_TRASHED', count: 1 }]);
    expect(res.body.total).toBe(1);
  });

  it('validates the range', async () => {
    const get = (query: string) => as(ctx, admin).get(`/api/v1/audit/report?${query}`);
    expect((await get(`from=${day(0)}&to=${day(-1)}`).expect(400)).body.code).toBe('INVALID_RANGE');
    expect((await get(`from=${day(-400)}&to=${day(0)}`).expect(400)).body.code).toBe(
      'RANGE_TOO_LONG',
    );
    await get('from=2026-02-30').expect(400);
    await get('from=yesterday').expect(400);
    await get('tenantId=x').expect(400);
  });

  it('is for admins only, and a denied attempt shows up in the next report', async () => {
    const before = (await as(ctx, admin).get('/api/v1/audit/report').expect(200)).body.denied;
    await as(ctx, member).get('/api/v1/audit/report').expect(403);
    const after = (await as(ctx, admin).get('/api/v1/audit/report').expect(200)).body.denied;
    expect(after).toBe(before + 1);
  });

  it('never counts another tenant', async () => {
    const res = await as(ctx, other).get('/api/v1/audit/report').expect(200);
    const created = res.body.byAction.find(
      (a: { action: string }) => a.action === 'RECORD_CREATED',
    );
    expect(created.count).toBe(5);
    expect(res.body.topUsers.map((u: { id: string }) => u.id)).not.toContain(member.userId);
    await ctx.http().get('/api/v1/audit/report').expect(401);
  });
});
