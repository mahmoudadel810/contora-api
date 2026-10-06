import { AUDIT_ACTIONS } from '../src/audit/audit-action.js';
import { addMember, as, signIn, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface Entry {
  action: string;
  actor: { id: string } | null;
}

const actionsOf = (body: { items: Entry[] }) => body.items.map((entry) => entry.action);

describe('audit filters (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Filter Co' });
    member = await addMember(ctx, admin);
    const ws = await workspace(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    await createRecord(ctx, admin, ws, { name: 'By admin' });
    await createRecord(ctx, member, ws, { name: 'By member' });
    await signIn(ctx, admin.email, admin.password);
    await admin.agent.post('/api/v1/auth/sign-out').expect(204);
    other = await signUp(ctx, { tenantName: 'Other Co' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  const get = (actor: Actor, query: string) => as(ctx, actor).get(`/api/v1/audit?${query}`);

  it('filters by several actions, as a comma list or as repeated parameters', async () => {
    const comma = await get(admin, 'actions=SIGN_UP,RECORD_CREATED&pageSize=100').expect(200);
    expect(new Set(actionsOf(comma.body))).toEqual(new Set(['SIGN_UP', 'RECORD_CREATED']));
    expect(comma.body.total).toBe(3);
    const repeated = await get(admin, 'actions=SIGN_UP&actions=RECORD_CREATED&pageSize=100').expect(
      200,
    );
    expect(repeated.body.items).toEqual(comma.body.items);
    const duplicated = await get(admin, 'actions=SIGN_UP,SIGN_UP&actions=SIGN_UP').expect(200);
    expect(duplicated.body.total).toBe(1);
  });

  it('accepts many repeated parameters within the bound', async () => {
    const query = Array.from({ length: 30 }, () => 'actions=SIGN_UP').join('&');
    const res = await get(admin, query).expect(200);
    expect(actionsOf(res.body)).toEqual(['SIGN_UP']);
  });

  it('merges the older action parameter into actions', async () => {
    const res = await get(admin, 'action=SIGN_UP&actions=SIGN_OUT&pageSize=100').expect(200);
    expect(new Set(actionsOf(res.body))).toEqual(new Set(['SIGN_UP', 'SIGN_OUT']));
    const legacy = await get(admin, 'action=RECORD_CREATED').expect(200);
    expect(legacy.body.total).toBe(2);
  });

  it('excludes actions, and exclusion wins over inclusion', async () => {
    const all = await get(admin, 'pageSize=100').expect(200);
    const signIns = actionsOf(all.body).filter((a) => a === 'SIGN_IN' || a === 'SIGN_OUT');
    expect(signIns.length).toBeGreaterThanOrEqual(3);
    const res = await get(admin, 'excludeActions=SIGN_IN,SIGN_OUT&pageSize=100').expect(200);
    expect(actionsOf(res.body)).not.toContain('SIGN_IN');
    expect(actionsOf(res.body)).not.toContain('SIGN_OUT');
    expect(res.body.total).toBe(all.body.total - signIns.length);
    const both = await get(
      admin,
      'actions=SIGN_IN,RECORD_CREATED&excludeActions=SIGN_IN&pageSize=100',
    ).expect(200);
    expect(new Set(actionsOf(both.body))).toEqual(new Set(['RECORD_CREATED']));
  });

  it('answers an empty page, not an error, when everything is excluded', async () => {
    const res = await get(admin, 'actions=SIGN_IN&excludeActions=SIGN_IN').expect(200);
    expect(res.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20, scope: 'tenant' });
    const everything = await get(admin, `excludeActions=${AUDIT_ACTIONS.join(',')}`).expect(200);
    expect(everything.body.total).toBe(0);
  });

  it('refuses unknown, empty and oversized values with 400 VALIDATION_FAILED', async () => {
    const tooMany = Array.from({ length: 51 }, () => 'actions=SIGN_UP').join('&');
    const longValue = Array.from({ length: 100 }, () => 'SIGN_IN').join(',');
    const tooLongInAll = [longValue, longValue, longValue]
      .map((v) => `excludeActions=${v}`)
      .join('&');
    for (const query of [
      'actions=NOPE',
      'actions=',
      'actions=SIGN_IN,',
      'actions=SIGN_IN,,SIGN_OUT',
      'actions=SIGN_IN&actions=',
      'excludeActions=bogus',
      'excludeActions=',
      `actions=${'SIGN_IN,'.repeat(200)}SIGN_IN`,
      tooMany,
      tooLongInAll,
    ]) {
      const res = await get(admin, query).expect(400);
      expect(res.body.code, query.slice(0, 60)).toBe('VALIDATION_FAILED');
    }
  });

  it('filters one member’s entries for admins, and refuses members the log', async () => {
    const mine = `actorId=${member.userId}`;
    const res = await get(
      admin,
      `${mine}&actions=SIGN_UP,SIGN_IN,RECORD_CREATED&pageSize=100`,
    ).expect(200);
    expect(new Set(actionsOf(res.body))).toEqual(new Set(['SIGN_IN', 'RECORD_CREATED']));
    expect(res.body.items.every((e: Entry) => e.actor?.id === member.userId)).toBe(true);
    const excluded = await get(
      admin,
      `${mine}&excludeActions=SIGN_IN,ACCESS_GRANTED&pageSize=100`,
    ).expect(200);
    expect(excluded.body.items.every((e: Entry) => e.actor?.id === member.userId)).toBe(true);
    expect(actionsOf(excluded.body)).toEqual(['RECORD_CREATED']);
    await get(member, 'actions=SIGN_UP,SIGN_IN,RECORD_CREATED&pageSize=100').expect(403);
    await get(member, 'excludeActions=SIGN_IN&pageSize=100').expect(403);
  });

  it('lists every audit action name for admins only, and only with a token', async () => {
    const forAdmin = await as(ctx, admin).get('/api/v1/audit/actions').expect(200);
    expect(forAdmin.body).toEqual([...AUDIT_ACTIONS]);
    expect(forAdmin.body).toEqual(
      expect.arrayContaining([
        'SIGN_UP',
        'INVITATION_ACCEPTED',
        'RECORD_CREATED',
        'RECORD_TRASHED',
        'ACCESS_DENIED',
      ]),
    );
    expect(new Set(forAdmin.body).size).toBe(forAdmin.body.length);
    expect(forAdmin.body.every((name: string) => /^[A-Z]+(_[A-Z]+)*$/.test(name))).toBe(true);
    await as(ctx, member).get('/api/v1/audit/actions').expect(403);
    const anonymous = await ctx.http().get('/api/v1/audit/actions').expect(401);
    expect(anonymous.body.code).toBe('UNAUTHENTICATED');
  });

  it('never returns another tenant’s entries', async () => {
    const res = await get(other, 'actions=RECORD_CREATED,SIGN_IN&pageSize=100').expect(200);
    expect(res.body.total).toBe(0);
    const excluded = await get(other, 'excludeActions=SIGN_IN&pageSize=100').expect(200);
    expect(actionsOf(excluded.body)).toEqual(['SIGN_UP']);
    expect(excluded.body.items[0].actor.id).toBe(other.userId);
  });
});
