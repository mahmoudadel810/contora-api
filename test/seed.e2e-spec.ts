import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { SeedModule } from '../src/seed/seed.module.js';
import {
  DEMO_ADMIN,
  DEMO_INVITEE,
  DEMO_MEMBER,
  DEMO_PASSWORD,
  DEMO_REMOVED,
  DEMO_SUSPENDED,
} from '../src/seed/demo-data.js';
import { SeedService } from '../src/seed/seed.service.js';
import { as, signIn } from './helpers/actors.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const ARABIC_MEMO = 'مُذَكِّرَة داخليــة';

describe('demo seed (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp([SeedModule]);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('creates the demo tenant once, with records that have at least three versions', async () => {
    const first = await ctx.app.get(SeedService).run();
    expect(first.created).toBe(true);
    const second = await ctx.app.get(SeedService).run();
    expect(second.created).toBe(false);

    const admin = await signIn(ctx, DEMO_ADMIN.email, DEMO_PASSWORD);
    const member = await signIn(ctx, DEMO_MEMBER.email, DEMO_PASSWORD);
    expect(admin.role).toBe('admin');
    expect(member.role).toBe('member');
    expect(member.tenantId).toBe(admin.tenantId);

    const types = await as(ctx, admin).get('/api/v1/content-types').expect(200);
    expect(types.body.map((t: { name: string }) => t.name)).toEqual([
      'Contract',
      'Invoice',
      'Memo',
      'Site visit',
    ]);
    expect(types.body.map((t: { aiExtraction: boolean }) => t.aiExtraction)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const tree = await as(ctx, admin).get('/api/v1/folders/tree').expect(200);
    expect(tree.body.length).toBe(7);
    const records = await as(ctx, admin).get('/api/v1/records?pageSize=100').expect(200);
    expect(records.body.total).toBe(11);
    for (const record of records.body.items as Array<{ id: string; currentVersion: number }>) {
      expect(record.currentVersion).toBeGreaterThanOrEqual(3);
      const history = await as(ctx, admin).get(`/api/v1/records/${record.id}/versions`).expect(200);
      expect(history.body).toHaveLength(record.currentVersion);
    }
    const locked = (
      records.body.items as Array<{ checkedOut: { displayName: string } | null }>
    ).filter((r) => r.checkedOut);
    expect(locked.map((r) => r.checkedOut?.displayName)).toEqual([DEMO_MEMBER.displayName]);
    const favorites = await as(ctx, admin).get('/api/v1/me/favorites').expect(200);
    expect(favorites.body).toHaveLength(2);
    const recent = await as(ctx, admin).get('/api/v1/me/recent').expect(200);
    expect(recent.body).toHaveLength(11);
    const memberFavorites = await as(ctx, member).get('/api/v1/me/favorites').expect(200);
    expect(memberFavorites.body).toHaveLength(1);
    const wayne = await as(ctx, admin).get('/api/v1/records?q=wayne&pageSize=5').expect(200);
    type Listed = { id: string; name: string; metadata: Record<string, unknown> };
    const byName = (name: string) =>
      (wayne.body.items as Listed[]).find((r) => r.name === name) as Listed;
    const msa = byName('Master services agreement — Wayne Enterprises');
    expect(msa.metadata).toMatchObject({
      departments: ['Legal', 'Finance'],
      portal: 'https://portal.wayne.example/contracts/msa',
      responsible: admin.userId,
    });
    const msaRelations = await as(ctx, member)
      .get(`/api/v1/records/${msa.id}/relations`)
      .expect(200);
    expect(msaRelations.body.total).toBe(3);
    expect(
      (msaRelations.body.items as Array<{ label: string; other: { name: string } }>)
        .map((r) => `${r.label}: ${r.other.name}`)
        .sort(),
    ).toEqual([
      'Has part: Wayne invoice WE-2026-01',
      'Has part: Wayne invoice WE-2026-02',
      'References: NDA — Stark Industries',
    ]);
    const invoice = byName('Wayne invoice WE-2026-01');
    const invoiceRelations = await as(ctx, member)
      .get(`/api/v1/records/${invoice.id}/relations`)
      .expect(200);
    expect(invoiceRelations.body).toMatchObject({
      total: 1,
      items: [
        {
          kind: 'partOf',
          direction: 'outgoing',
          label: 'Part of',
          other: {
            id: msa.id,
            name: 'Master services agreement — Wayne Enterprises',
            contentTypeName: 'Contract',
          },
        },
      ],
    });
    expect(
      invoiceRelations.body.items[0].other.folderPath.map((c: { name: string }) => c.name),
    ).toEqual(['Legal', 'Contracts']);
    const msaActivity = await as(ctx, member).get(`/api/v1/records/${msa.id}/activity`).expect(200);
    const msaActions = (msaActivity.body.items as Array<{ action: string }>).map((e) => e.action);
    expect(msaActions).toEqual(
      expect.arrayContaining(['RECORD_CREATED', 'VERSION_CREATED', 'RELATION_ADDED']),
    );
    const overview = await as(ctx, admin).get('/api/v1/admin/overview').expect(200);
    expect(overview.body).toMatchObject({
      members: { active: 2, suspended: 1, removed: 1, activeAdmins: 1 },
      invitations: { pending: 1 },
      records: { live: 11, trashed: 1, createdLast7Days: 12, createdLast30Days: 12 },
      contentTypes: { active: 4, archived: 0 },
    });
    const aliceInbox = await as(ctx, admin).get('/api/v1/notifications').expect(200);
    expect(aliceInbox.body.items[0]).toMatchObject({ kind: 'COMMENT_ON_RECORD', read: false });
    const bobInbox = await as(ctx, member).get('/api/v1/notifications').expect(200);
    expect(bobInbox.body.unread).toBeGreaterThanOrEqual(1);

    const bobAccess = await as(ctx, member).get('/api/v1/me/access').expect(200);
    expect(bobAccess.body).toEqual({
      unrestricted: false,
      entryPoints: [
        { type: 'folder', id: expect.any(String), name: 'Finance', level: 'edit' },
        { type: 'folder', id: expect.any(String), name: 'Legal', level: 'view' },
        {
          type: 'record',
          id: expect.any(String),
          name: 'Employment contract — Bob Member',
          level: 'view',
        },
      ],
    });
    const bobTree = await as(ctx, member).get('/api/v1/folders/tree').expect(200);
    expect(bobTree.body.map((f: { name: string }) => f.name).sort()).toEqual([
      '2026',
      'Contracts',
      'Finance',
      'Invoices',
      'Legal',
    ]);
    await as(ctx, member).get('/api/v1/folders/root').expect(404);
    const bobRecords = await as(ctx, member).get('/api/v1/records?pageSize=100').expect(200);
    expect(bobRecords.body.total).toBe(10);
    const contract = (
      bobRecords.body.items as Array<{ name: string; folderId: string | null }>
    ).find((r) => r.name === 'Employment contract — Bob Member');
    expect(contract?.folderId).toBeNull();
    const saved = await as(ctx, admin).get('/api/v1/saved-searches').expect(200);
    expect(saved.body.map((s: { name: string }) => s.name)).toEqual([
      'Contracts up for renewal',
      'Open invoices',
    ]);

    const found = async (q: string) =>
      (
        (
          await as(ctx, admin)
            .get(`/api/v1/records?q=${encodeURIComponent(q)}`)
            .expect(200)
        ).body.items as Array<{ name: string }>
      )
        .map((r) => r.name)
        .sort();
    expect(await found('احمد')).toEqual(['مؤسسة أحمد للتجارة']);
    expect(await found('مدرسه')).toEqual(['فاتورة رقم ١٠٢٤']);
    expect(await found('1024')).toEqual(['فاتورة رقم ١٠٢٤']);
    expect(await found('مذكرة داخلية')).toEqual([ARABIC_MEMO]);
    expect(await found('ايجار')).toEqual(['عقد إيجار المكتب']);

    const people = await as(ctx, admin).get('/api/v1/members').expect(200);
    const statusOf = (email: string) =>
      (people.body as Array<{ email: string; status: string }>).find((u) => u.email === email)
        ?.status;
    expect(statusOf(DEMO_SUSPENDED.email)).toBe('suspended');
    expect(statusOf(DEMO_REMOVED.email)).toBe('removed');
    await ctx
      .http()
      .post('/api/v1/auth/sign-in')
      .send({ email: DEMO_SUSPENDED.email, password: DEMO_PASSWORD })
      .expect(401);
    const invites = await as(ctx, admin).get('/api/v1/invitations').expect(200);
    expect(invites.body).toMatchObject([
      { email: DEMO_INVITEE.email, status: 'pending', invitedBy: { id: admin.userId } },
    ]);
    const statusActions = (
      await as(ctx, admin)
        .get('/api/v1/audit?actions=MEMBER_SUSPENDED,MEMBER_REMOVED,INVITATION_CREATED')
        .expect(200)
    ).body.items as Array<{ action: string; actor: { id: string } }>;
    expect(statusActions.map((e) => e.action).sort()).toEqual([
      'INVITATION_CREATED',
      'MEMBER_REMOVED',
      'MEMBER_SUSPENDED',
    ]);
    expect(statusActions.every((e) => e.actor.id === admin.userId)).toBe(true);

    const trash = await as(ctx, admin).get('/api/v1/trash').expect(200);
    expect(
      (trash.body.records as Array<{ name: string; deletedBy: { id: string } }>).map((r) => r.name),
    ).toEqual(['Globex invoice INV-2026-001 (duplicate upload)']);
  });

  it('shows a mention: Alice’s NDA comment mentions Bob, who gets a MENTION', async () => {
    const admin = await signIn(ctx, DEMO_ADMIN.email, DEMO_PASSWORD);
    const member = await signIn(ctx, DEMO_MEMBER.email, DEMO_PASSWORD);
    const nda = (
      await as(ctx, admin).get('/api/v1/records?q=Stark&pageSize=5').expect(200)
    ).body.items.find((r: { name: string }) => r.name === 'NDA — Stark Industries') as {
      id: string;
    };
    const comments = await as(ctx, admin).get(`/api/v1/records/${nda.id}/comments`).expect(200);
    expect(comments.body).toMatchObject([
      {
        body: `Countersigned copy filed; @{user:${member.userId}} please send it to Stark.`,
        mentions: [
          { type: 'user', id: member.userId, displayName: DEMO_MEMBER.displayName, active: true },
        ],
      },
    ]);
    const inbox = await as(ctx, member).get('/api/v1/notifications').expect(200);
    const mentions = (inbox.body.items as Array<{ kind: string; recordId: string; body: string }>)
      .filter((n) => n.kind === 'MENTION')
      .map(({ recordId, body }) => ({ recordId, body }));
    expect(mentions).toEqual([
      {
        recordId: nda.id,
        body: `Countersigned copy filed; @${DEMO_MEMBER.displayName} please send it to Stark.`,
      },
    ]);
  });

  it('adds nothing on a second run: every collection keeps its count', async () => {
    const before = await collectionCounts(ctx);
    const again = await ctx.app.get(SeedService).run();
    expect(again).toMatchObject({ created: false, added: [] });
    expect(await collectionCounts(ctx)).toEqual(before);
  });
});

async function collectionCounts(ctx: TestApp): Promise<Record<string, number>> {
  const connection = ctx.app.get<Connection>(getConnectionToken());
  const counts: Record<string, number> = {};
  for (const name of Object.keys(connection.collections).sort()) {
    counts[name] = await connection.collection(name).countDocuments();
  }
  return counts;
}

describe('demo seed top-up of an older demo tenant (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp([SeedModule]);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('restores exactly what an older demo tenant is missing, and nothing else', async () => {
    expect((await ctx.app.get(SeedService).run()).created).toBe(true);
    const full = await collectionCounts(ctx);
    const connection = ctx.app.get<Connection>(getConnectionToken());
    const db = (name: string) => connection.collection(name);

    const newer = [
      'Wayne invoice WE-2026-01',
      'Wayne invoice WE-2026-02',
      'Globex invoice INV-2026-001 (duplicate upload)',
      'Employment contract — Bob Member',
    ];
    const newerIds = (
      await db('records')
        .find({ name: { $in: newer } })
        .toArray()
    ).map((r) => r._id);
    expect(newerIds).toHaveLength(4);
    await db('record_versions').deleteMany({ recordId: { $in: newerIds } });
    await db('records').deleteMany({ _id: { $in: newerIds } });
    for (const name of [
      'record_relations',
      'record_favorites',
      'record_views',
      'record_comments',
      'notifications',
      'saved_searches',
      'invitations',
      'access_grants',
    ]) {
      await db(name).deleteMany({});
    }
    await db('users').deleteMany({ email: { $in: [DEMO_SUSPENDED.email, DEMO_REMOVED.email] } });
    const contract = await db('content_types').findOne({ name: 'Contract' });
    await db('content_types').updateOne(
      { name: 'Contract' },
      { $set: { fields: ((contract?.fields ?? []) as unknown[]).slice(0, 6), schemaVersion: 1 } },
    );
    await db('content_types').deleteOne({ name: 'Site visit' });
    expect((await collectionCounts(ctx)).records).toBe(8);

    const topUp = await ctx.app.get(SeedService).run();
    expect(topUp.created).toBe(false);
    const admin = DEMO_ADMIN.email;
    const member = DEMO_MEMBER.email;
    const msa = 'Master services agreement — Wayne Enterprises';
    expect([...topUp.added].sort()).toEqual(
      [
        'fields departments, portal, responsible on Contract',
        'content type Site visit',
        'record Wayne invoice WE-2026-01',
        'record Wayne invoice WE-2026-02',
        'record Globex invoice INV-2026-001 (duplicate upload)',
        'record Employment contract — Bob Member',
        'recently viewed Employment contract — Bob Member',
        `edit grant on folder Finance for ${member}`,
        `view grant on folder Legal for ${member}`,
        `edit grant on folder Legal/Contracts for ${member}`,
        `view grant on record Employment contract — Bob Member for ${member}`,
        `favorite Globex invoice INV-2026-001 for ${admin}`,
        `favorite ${msa} for ${admin}`,
        `favorite ${msa} for ${member}`,
        'recently viewed Globex invoice INV-2026-001',
        'recently viewed Initech invoice INV-7781',
        `recently viewed ${msa}`,
        'recently viewed NDA — Stark Industries',
        'recently viewed Wayne invoice WE-2026-01',
        'recently viewed Wayne invoice WE-2026-02',
        'recently viewed مؤسسة أحمد للتجارة',
        'recently viewed عقد إيجار المكتب',
        `recently viewed ${ARABIC_MEMO}`,
        'recently viewed فاتورة رقم ١٠٢٤',
        `comment on ${msa} by ${member}`,
        `comment on NDA — Stark Industries by ${admin}`,
        `relation Wayne invoice WE-2026-01 partOf ${msa}`,
        `relation Wayne invoice WE-2026-02 partOf ${msa}`,
        `relation ${msa} references NDA — Stark Industries`,
        'saved search Open invoices',
        'saved search Contracts up for renewal',
        `member ${DEMO_SUSPENDED.email}`,
        `member ${DEMO_REMOVED.email}`,
        `invitation ${DEMO_INVITEE.email}`,
      ].sort(),
    );
    const { audit_entries: auditAfter, ...after } = await collectionCounts(ctx);
    const { audit_entries: auditFull, ...fullWithoutAudit } = full;
    expect(after).toEqual(fullWithoutAudit);
    expect(auditAfter).toBeGreaterThan(auditFull);
    const topped = await db('content_types').findOne({ name: 'Contract' });
    expect((topped?.fields ?? []) as unknown[]).toHaveLength(9);
    expect(topped?.schemaVersion).toBe(2);
    expect((await db('content_types').findOne({ name: 'Invoice' }))?.schemaVersion).toBe(1);
    const visit = await db('content_types').findOne({ name: 'Site visit' });
    expect(((visit?.fields ?? []) as Array<{ type: string }>).map((f) => f.type)).toContain(
      'currency',
    );

    expect((await ctx.app.get(SeedService).run()).added).toEqual([]);
  });
});
