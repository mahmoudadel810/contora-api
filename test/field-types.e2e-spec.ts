import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const MATTER_TYPE = {
  name: 'Matter',
  fields: [
    { key: 'title', label: 'Title', type: 'text', required: true },
    {
      key: 'teams',
      label: 'Teams',
      type: 'multiselect',
      required: true,
      options: ['Legal', 'Finance', 'HR'],
      defaultValue: ['Legal'],
    },
    { key: 'portal', label: 'Portal link', type: 'url', required: false },
    { key: 'owner', label: 'Owner', type: 'user', required: false },
  ],
};

describe('multi-select, URL and user fields (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;
  let typeId: string;

  const create = (actor: Actor, metadata: Record<string, unknown>, name = 'Matter') =>
    as(ctx, actor)
      .post('/api/v1/records')
      .send({ name, contentTypeId: typeId, folderId: ws.folderId, metadata });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Fields Co', displayName: 'Fay Admin' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
    typeId = (await as(ctx, admin).post('/api/v1/content-types').send(MATTER_TYPE).expect(201)).body
      .id;
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('stores valid values, applies the multi-select default and exports readable cells', async () => {
    const full = await create(
      member,
      {
        title: 'Merger',
        teams: ['Finance', 'Legal'],
        portal: 'https://deals.example.com/m/1',
        owner: admin.userId,
      },
      'Merger file',
    ).expect(201);
    expect(full.body.metadata).toEqual({
      title: 'Merger',
      teams: ['Finance', 'Legal'],
      portal: 'https://deals.example.com/m/1',
      owner: admin.userId,
    });
    const defaulted = await create(member, { title: 'Hiring' }, 'Hiring file').expect(201);
    expect(defaulted.body.metadata.teams).toEqual(['Legal']);

    const csv = await as(ctx, admin)
      .get(`/api/v1/records/export?contentTypeId=${typeId}&sort=name&order=asc`)
      .expect(200);
    const [header, , merger] = csv.text.trim().split('\r\n');
    expect(header.endsWith(',Title,Teams,Portal link,Owner')).toBe(true);
    expect(merger.endsWith(',Merger,Finance; Legal,https://deals.example.com/m/1,Fay Admin')).toBe(
      true,
    );
  });

  it('searches multi-select, URL and user fields', async () => {
    await create(
      member,
      { title: 'HR only', teams: ['HR'], owner: member.userId },
      'HR matter',
    ).expect(201);
    const names = async (query: string) =>
      (
        await as(ctx, admin).get(`/api/v1/records?contentTypeId=${typeId}&${query}`).expect(200)
      ).body.items
        .map((r: { name: string }) => r.name)
        .sort();
    expect(await names('meta.teams=HR')).toEqual(['HR matter']);
    expect(await names('meta.teams=Legal')).toEqual(['Hiring file', 'Merger file']);
    expect(await names(`meta.owner=${member.userId}`)).toEqual(['HR matter']);
    expect(await names('meta.portal=deals.example')).toEqual(['Merger file']);
    expect(await names('q=finance')).toEqual(['Merger file']);
  });

  it('rejects bad options, unsafe links and users who are not active members of the tenant', async () => {
    const pathsOf = async (metadata: Record<string, unknown>) =>
      (await create(admin, { title: 'Bad', ...metadata }).expect(400)).body.details.map(
        (d: { path: string }) => d.path,
      );
    expect(await pathsOf({ teams: ['Sales'] })).toContain('metadata.teams.0');
    expect(await pathsOf({ teams: ['HR', 'HR'] })).toContain('metadata.teams');
    expect(await pathsOf({ portal: 'javascript:alert(1)' })).toContain('metadata.portal');
    expect(await pathsOf({ owner: other.userId })).toEqual(['metadata.owner']);
    expect(await pathsOf({ owner: '64b000000000000000000001' })).toEqual(['metadata.owner']);

    const leaver = await addMember(ctx, admin);
    await as(ctx, admin).delete(`/api/v1/members/${leaver.userId}`).expect(204);
    expect(await pathsOf({ owner: leaver.userId })).toEqual(['metadata.owner']);
  });

  it('checks user fields on new metadata versions too, but keeps history as it was', async () => {
    const colleague = await addMember(ctx, admin);
    const record = await create(admin, { title: 'Owned', owner: colleague.userId }).expect(201);
    await as(ctx, admin)
      .post(`/api/v1/records/${record.body.id}/versions`)
      .send({ metadata: { title: 'Owned', owner: other.userId } })
      .expect(400);
    await as(ctx, admin).delete(`/api/v1/members/${colleague.userId}`).expect(204);
    await as(ctx, admin)
      .post(`/api/v1/records/${record.body.id}/versions`)
      .send({ metadata: { title: 'Owned v2', owner: admin.userId } })
      .expect(201);
    await as(ctx, admin)
      .post(`/api/v1/records/${record.body.id}/versions/1/restore`)
      .send({})
      .expect(201);
  });

  it('keeps a departed owner when other fields change, and treats an empty list as not set', async () => {
    const leaver = await addMember(ctx, admin);
    const record = await create(admin, { title: 'Kept', owner: leaver.userId }).expect(201);
    await as(ctx, admin).delete(`/api/v1/members/${leaver.userId}`).expect(204);
    const next = await as(ctx, admin)
      .post(`/api/v1/records/${record.body.id}/versions`)
      .send({ metadata: { title: 'Kept, renamed', owner: leaver.userId } })
      .expect(201);
    expect(next.body.metadata.owner).toBe(leaver.userId);
    const defaulted = await create(admin, { title: 'Empty teams', teams: [] }).expect(201);
    expect(defaulted.body.metadata.teams).toEqual(['Legal']);
  });

  it('rejects field definitions that cannot work', async () => {
    const define = (field: Record<string, unknown>) =>
      as(ctx, admin)
        .post('/api/v1/content-types')
        .send({ name: `Bad ${Math.random()}`, fields: [{ key: 'f', label: 'F', ...field }] });
    await define({ type: 'multiselect' }).expect(400);
    await define({ type: 'user', defaultValue: admin.userId }).expect(400);
    await define({ type: 'url', defaultValue: 'javascript:void(0)' }).expect(400);
  });

  it('never accepts a user from another tenant, even through another tenant’s type id', async () => {
    await as(ctx, other)
      .post('/api/v1/records')
      .send({ name: 'x', contentTypeId: typeId, folderId: ws.folderId, metadata: {} })
      .expect(404);
  });
});
