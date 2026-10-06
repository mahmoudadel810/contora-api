import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { RecordEntity } from '../src/records/record.schema.js';
import { pairKeyOf } from '../src/relations/relation-kinds.js';
import { RecordRelation } from '../src/relations/relation.schema.js';
import { RelationsRepository } from '../src/relations/relations.repository.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace, grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface Relation {
  id: string;
  kind: string;
  direction: 'outgoing' | 'incoming';
  label: string;
  other: {
    id: string;
    name: string;
    contentTypeName: string | null;
    folderId: string;
    folderPath: { id: string; name: string }[];
  };
  createdBy: { id: string; displayName: string };
  createdAt: string;
}

describe('record relations (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;
  let ws: Workspace;
  let otherWs: Workspace;
  let relations: Model<RecordRelation>;
  let recordsModel: Model<RecordEntity>;
  let seq = 0;

  const url = (id: string) => `/api/v1/records/${id}/relations`;

  async function record(actor: Actor = admin, space: Workspace = ws): Promise<string> {
    seq += 1;
    return (await createRecord(ctx, actor, space, { name: `Doc ${seq}` })).id;
  }

  async function folder(name: string): Promise<Workspace> {
    const res = await as(ctx, admin)
      .post('/api/v1/folders')
      .send({ name, parentId: ws.rootId })
      .expect(201);
    return { ...ws, folderId: res.body.id as string };
  }

  function relate(actor: Actor, id: string, body: Record<string, unknown>) {
    return as(ctx, actor).post(url(id)).send(body);
  }

  async function listOf(actor: Actor, id: string): Promise<{ items: Relation[]; total: number }> {
    return (await as(ctx, actor).get(url(id)).expect(200)).body;
  }

  async function auditCount(action: string, resourceId: string): Promise<number> {
    const res = await as(ctx, admin)
      .get(`/api/v1/audit?action=${action}&resourceId=${resourceId}`)
      .expect(200);
    return res.body.total as number;
  }

  async function rowsWith(id: string): Promise<number> {
    const oid = new Types.ObjectId(id);
    return relations.countDocuments({ $or: [{ sourceId: oid }, { targetId: oid }] }).exec();
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Link Co', displayName: 'Ada Admin' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
    otherWs = await workspace(ctx, other);
    relations = ctx.app.get<Model<RecordRelation>>(getModelToken(RecordRelation.name));
    recordsModel = ctx.app.get<Model<RecordEntity>>(getModelToken(RecordEntity.name));
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('lists every kind on both records with the right label, direction and other record', async () => {
    const sub = await as(ctx, admin)
      .post('/api/v1/folders')
      .send({ name: '2026', parentId: ws.folderId })
      .expect(201);
    const a = await record();
    const b = (
      await createRecord(ctx, admin, { ...ws, folderId: sub.body.id }, { name: 'Target doc' })
    ).id;
    for (const kind of ['relatedTo', 'references', 'supersedes', 'partOf']) {
      const res = await relate(member, a, { kind, otherId: b }).expect(201);
      expect(res.body).toMatchObject({ kind, direction: 'outgoing', other: { id: b } });
    }

    const fromA = await listOf(admin, a);
    expect(fromA.total).toBe(4);
    expect(fromA.items.map((r) => [r.kind, r.direction, r.label])).toEqual([
      ['partOf', 'outgoing', 'Part of'],
      ['supersedes', 'outgoing', 'Supersedes'],
      ['references', 'outgoing', 'References'],
      ['relatedTo', 'outgoing', 'Related to'],
    ]);
    expect(fromA.items[0]).toMatchObject({
      other: {
        id: b,
        name: 'Target doc',
        contentTypeName: 'Invoice Invoices',
        folderId: sub.body.id,
        folderPath: [
          { id: ws.rootId, name: 'Repository' },
          { id: ws.folderId, name: 'Invoices' },
          { id: sub.body.id, name: '2026' },
        ],
      },
      createdBy: { id: member.userId, displayName: member.displayName },
    });
    expect(new Date(fromA.items[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(fromA.items[3].createdAt).getTime(),
    );

    const fromB = await listOf(member, b);
    expect(fromB.total).toBe(4);
    expect(fromB.items.map((r) => [r.kind, r.direction, r.label])).toEqual([
      ['partOf', 'incoming', 'Has part'],
      ['supersedes', 'incoming', 'Superseded by'],
      ['references', 'incoming', 'Referenced by'],
      ['relatedTo', 'incoming', 'Related to'],
    ]);
    expect(fromB.items[0].other).toMatchObject({
      id: a,
      folderPath: [
        { id: ws.rootId, name: 'Repository' },
        { id: ws.folderId, name: 'Invoices' },
      ],
    });
    expect(fromB.items.map((r) => r.id)).toEqual(fromA.items.map((r) => r.id));
  });

  it('stores swapped ends for the incoming direction and audits the record acted on', async () => {
    const invoice = await record();
    const contract = await record();
    const res = await relate(admin, contract, {
      kind: 'partOf',
      otherId: invoice,
      direction: 'incoming',
    }).expect(201);
    expect(res.body).toMatchObject({
      kind: 'partOf',
      direction: 'incoming',
      label: 'Has part',
      other: { id: invoice },
    });
    const row = await relations.findById(res.body.id).exec();
    expect(row?.sourceId.toHexString()).toBe(invoice);
    expect(row?.targetId.toHexString()).toBe(contract);
    expect(row?.pairKey).toBe(pairKeyOf(invoice, contract));
    const fromInvoice = await listOf(admin, invoice);
    expect(fromInvoice.items[0]).toMatchObject({ direction: 'outgoing', label: 'Part of' });

    const audit = await as(ctx, admin)
      .get(`/api/v1/audit?action=RELATION_ADDED&resourceId=${contract}`)
      .expect(200);
    expect(audit.body.total).toBe(1);
    expect(audit.body.items[0]).toMatchObject({
      resource: { type: 'record', id: contract, label: expect.any(String) },
      context: {
        relationId: res.body.id,
        kind: 'partOf',
        direction: 'incoming',
        label: 'Has part',
        otherId: invoice,
      },
    });
    expect(await auditCount('RELATION_ADDED', invoice)).toBe(0);
  });

  it('validates the body and refuses self-relations', async () => {
    const a = await record();
    const b = await record();
    for (const body of [
      { kind: 'bogus', otherId: b },
      { kind: 'references', otherId: b, note: 'extra' },
      { kind: 'references' },
      { kind: 'references', otherId: b, direction: 'sideways' },
    ]) {
      const res = await relate(admin, a, body).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    const self = await relate(admin, a, { kind: 'relatedTo', otherId: a }).expect(400);
    expect(self.body.code).toBe('SELF_RELATION');
    expect(await rowsWith(a)).toBe(0);
  });

  it('returns 404 for missing, malformed and trashed records on either end', async () => {
    const a = await record();
    const trashed = await record();
    await as(ctx, admin).delete(`/api/v1/records/${trashed}`).expect(204);
    const missing = new Types.ObjectId().toHexString();
    await relate(admin, a, { kind: 'references', otherId: missing }).expect(404);
    await relate(admin, a, { kind: 'references', otherId: 'nope' }).expect(404);
    await relate(admin, a, { kind: 'references', otherId: trashed }).expect(404);
    await relate(admin, trashed, { kind: 'references', otherId: a }).expect(404);
    await relate(admin, missing, { kind: 'references', otherId: a }).expect(404);
    await as(ctx, admin).get(url(missing)).expect(404);
    await as(ctx, admin).get(url(trashed)).expect(404);
    await as(ctx, admin).get(url('nope')).expect(404);
    expect(await rowsWith(a)).toBe(0);
  });

  it('refuses duplicates, reversed relatedTo and reversed pairs, but allows another kind', async () => {
    const a = await record();
    const b = await record();
    await relate(admin, a, { kind: 'references', otherId: b }).expect(201);
    await relate(admin, a, { kind: 'relatedTo', otherId: b }).expect(201);
    const conflicts: Array<[Actor, string, Record<string, unknown>]> = [
      [admin, a, { kind: 'references', otherId: b }],
      [member, b, { kind: 'references', otherId: a, direction: 'incoming' }],
      [member, b, { kind: 'references', otherId: a }],
      [member, b, { kind: 'relatedTo', otherId: a }],
      [admin, a, { kind: 'relatedTo', otherId: b, direction: 'incoming' }],
    ];
    for (const [actor, id, body] of conflicts) {
      const res = await relate(actor, id, body).expect(409);
      expect(res.body.code).toBe('RELATION_EXISTS');
    }
    await relate(member, b, { kind: 'supersedes', otherId: a }).expect(201);
    expect(await rowsWith(a)).toBe(3);
    expect(await auditCount('RELATION_ADDED', a)).toBe(2);
    expect(await auditCount('RELATION_ADDED', b)).toBe(1);
  });

  it('lets exactly one of several parallel identical creates succeed', async () => {
    const a = await record();
    const b = await record();
    const results = await Promise.all([
      relate(admin, a, { kind: 'partOf', otherId: b }),
      relate(member, a, { kind: 'partOf', otherId: b }),
      relate(admin, b, { kind: 'partOf', otherId: a, direction: 'incoming' }),
    ]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409, 409]);
    for (const res of results.filter((r) => r.status === 409)) {
      expect(res.body.code).toBe('RELATION_EXISTS');
    }
    expect(await rowsWith(a)).toBe(1);

    const symmetric = await Promise.all([
      relate(admin, a, { kind: 'relatedTo', otherId: b }),
      relate(member, b, { kind: 'relatedTo', otherId: a }),
    ]);
    expect(symmetric.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409]);
    expect(await rowsWith(a)).toBe(2);
  });

  it('caps a record at 50 outgoing relations, counting hidden ones', async () => {
    const a = await record();
    const b = await record();
    const tenantId = new Types.ObjectId(admin.tenantId);
    const source = new Types.ObjectId(a);
    await relations.insertMany(
      Array.from({ length: 50 }, () => {
        const target = new Types.ObjectId();
        return {
          tenantId,
          sourceId: source,
          targetId: target,
          kind: 'references',
          pairKey: pairKeyOf(a, target.toHexString()),
          createdBy: new Types.ObjectId(admin.userId),
          createdByName: 'Seeder',
        };
      }),
    );
    const limit = await relate(admin, a, { kind: 'references', otherId: b }).expect(409);
    expect(limit.body.code).toBe('RELATION_LIMIT');
    const viaInverse = await relate(admin, b, {
      kind: 'references',
      otherId: a,
      direction: 'incoming',
    }).expect(409);
    expect(viaInverse.body.code).toBe('RELATION_LIMIT');
    await relate(admin, a, { kind: 'references', otherId: b, direction: 'incoming' }).expect(201);
    const list = await listOf(admin, a);
    expect(list.total).toBe(1);
    expect(list.items).toHaveLength(1);
    expect(await auditCount('RELATION_ADDED', a)).toBe(1);
  });

  it('returns the 200 newest relations and the real total', async () => {
    const hub = await record();
    const hubId = new Types.ObjectId(hub);
    const tenantId = new Types.ObjectId(admin.tenantId);
    const userId = new Types.ObjectId(admin.userId);
    const others = Array.from({ length: 205 }, () => new Types.ObjectId());
    await recordsModel.collection.insertMany(
      others.map((_id, index) => ({
        _id,
        tenantId,
        name: `Bulk ${index}`,
        contentTypeId: new Types.ObjectId(ws.typeId),
        folderId: new Types.ObjectId(ws.folderId),
        currentVersion: 1,
        currentVersionId: new Types.ObjectId(),
        metadata: {},
        schemaVersion: 1,
        file: null,
        searchText: '',
        tags: [],
        createdBy: userId,
        createdByName: 'Seeder',
        updatedBy: userId,
        updatedByName: 'Seeder',
        checkedOutBy: null,
        deletedAt: null,
        trashBatchId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    const base = Date.now() - 1_000_000;
    await relations.collection.insertMany(
      others.map((id, index) => ({
        tenantId,
        sourceId: id,
        targetId: hubId,
        kind: 'partOf',
        pairKey: pairKeyOf(id.toHexString(), hub),
        createdBy: userId,
        createdByName: 'Seeder',
        createdAt: new Date(base + index * 1000),
      })),
    );
    const list = await listOf(admin, hub);
    expect(list.total).toBe(205);
    expect(list.items).toHaveLength(200);
    expect(list.items[0].other.name).toBe('Bulk 204');
    expect(list.items[199].other.name).toBe('Bulk 5');
    expect(list.items.every((r) => r.direction === 'incoming' && r.label === 'Has part')).toBe(
      true,
    );
  });

  it('removes a relation from either end, once, with one audit entry each', async () => {
    const a = await record();
    const b = await record();
    const first = await relate(admin, a, { kind: 'references', otherId: b }).expect(201);
    const second = await relate(member, a, { kind: 'supersedes', otherId: b }).expect(201);
    await as(ctx, member)
      .delete(`${url(b)}/${first.body.id}`)
      .expect(204);
    await as(ctx, admin)
      .delete(`${url(a)}/${second.body.id}`)
      .expect(204);
    expect(await rowsWith(a)).toBe(0);
    expect(await auditCount('RELATION_REMOVED', b)).toBe(1);
    expect(await auditCount('RELATION_REMOVED', a)).toBe(1);
    const audit = await as(ctx, admin)
      .get(`/api/v1/audit?action=RELATION_REMOVED&resourceId=${b}`)
      .expect(200);
    expect(audit.body.items[0]).toMatchObject({
      actor: { id: member.userId },
      resource: { type: 'record', id: b },
      context: {
        relationId: first.body.id,
        kind: 'references',
        direction: 'incoming',
        label: 'Referenced by',
        otherId: a,
      },
    });
    await as(ctx, admin)
      .delete(`${url(a)}/${first.body.id}`)
      .expect(404);
  });

  it('returns 404 for an unknown relation or one that belongs to other records', async () => {
    const a = await record();
    const c = await record();
    const d = await record();
    const elsewhere = await relate(admin, c, { kind: 'references', otherId: d }).expect(201);
    await as(ctx, admin)
      .delete(`${url(a)}/${elsewhere.body.id}`)
      .expect(404);
    await as(ctx, admin)
      .delete(`${url(a)}/${new Types.ObjectId().toHexString()}`)
      .expect(404);
    await as(ctx, admin)
      .delete(`${url(a)}/nope`)
      .expect(404);
    expect(await rowsWith(c)).toBe(1);
    expect(await auditCount('RELATION_REMOVED', a)).toBe(0);
  });

  it('lets only one of two concurrent deletes remove the relation', async () => {
    const a = await record();
    const b = await record();
    const created = await relate(admin, a, { kind: 'relatedTo', otherId: b }).expect(201);
    const repository = ctx.app.get(RelationsRepository, { strict: false });
    const deleteOne = repository.deleteOne.bind(repository);
    const spy = vi.spyOn(repository, 'deleteOne').mockImplementationOnce(async (...args) => {
      await as(ctx, member)
        .delete(`${url(b)}/${created.body.id}`)
        .expect(204);
      return deleteOne(...args);
    });
    try {
      const res = await as(ctx, admin)
        .delete(`${url(a)}/${created.body.id}`)
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
    } finally {
      spy.mockRestore();
    }
    expect(await rowsWith(a)).toBe(0);
    expect(
      (await auditCount('RELATION_REMOVED', a)) + (await auditCount('RELATION_REMOVED', b)),
    ).toBe(1);

    const again = await relate(admin, a, { kind: 'relatedTo', otherId: b }).expect(201);
    const parallel = await Promise.all([
      as(ctx, admin).delete(`${url(a)}/${again.body.id}`),
      as(ctx, member).delete(`${url(b)}/${again.body.id}`),
    ]);
    expect(parallel.map((r) => r.status).sort((x, y) => x - y)).toEqual([204, 404]);
    expect(
      (await auditCount('RELATION_REMOVED', a)) + (await auditCount('RELATION_REMOVED', b)),
    ).toBe(2);
  });

  it('does not keep a relation to a record purged while the relation was being added', async () => {
    const a = await record();
    const b = await record();
    const repository = ctx.app.get(RelationsRepository, { strict: false });
    const create = repository.create.bind(repository);
    const spy = vi.spyOn(repository, 'create').mockImplementationOnce(async (...args) => {
      await as(ctx, admin).delete(`/api/v1/records/${b}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/trash/records/${b}`).expect(200);
      return create(...args);
    });
    try {
      const res = await relate(member, a, { kind: 'relatedTo', otherId: b }).expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
    } finally {
      spy.mockRestore();
    }
    expect(await rowsWith(a)).toBe(0);
    expect(await rowsWith(b)).toBe(0);
    expect(await auditCount('RELATION_ADDED', a)).toBe(0);
  });

  it('adds a relation while someone else holds the check-out on both ends', async () => {
    const a = await record();
    const b = await record();
    await as(ctx, member).post(`/api/v1/records/${a}/checkout`).expect(200);
    await as(ctx, member).post(`/api/v1/records/${b}/checkout`).expect(200);
    const res = await relate(admin, a, { kind: 'references', otherId: b }).expect(201);
    await relate(admin, b, { kind: 'partOf', otherId: a }).expect(201);
    await as(ctx, admin)
      .delete(`${url(a)}/${res.body.id}`)
      .expect(204);
  });

  it('hides relations while either end is trashed (single, bulk, folder) and shows them after restore', async () => {
    const a = await record();
    const b = await record();
    const c = await record();
    const filed = await folder('Relations trash');
    const d = (await createRecord(ctx, admin, filed, { name: 'Filed doc' })).id;
    const toB = await relate(admin, a, { kind: 'references', otherId: b }).expect(201);
    await relate(admin, c, { kind: 'partOf', otherId: a }).expect(201);
    await relate(admin, a, { kind: 'relatedTo', otherId: d }).expect(201);
    expect((await listOf(admin, a)).total).toBe(3);

    await as(ctx, admin).delete(`/api/v1/records/${b}`).expect(204);
    expect((await listOf(admin, a)).items.map((r) => r.other.id).sort()).toEqual([c, d].sort());
    await as(ctx, admin).get(url(b)).expect(404);
    await as(ctx, admin)
      .delete(`${url(a)}/${toB.body.id}`)
      .expect(404);
    await as(ctx, admin).post(`/api/v1/trash/records/${b}/restore`).expect(200);
    expect((await listOf(admin, a)).total).toBe(3);
    expect((await listOf(admin, b)).items[0]).toMatchObject({ label: 'Referenced by' });

    await as(ctx, admin)
      .post('/api/v1/bulk/records/trash')
      .send({ ids: [c] })
      .expect(200);
    const withoutC = await listOf(admin, a);
    expect(withoutC.total).toBe(2);
    expect(withoutC.items.some((r) => r.other.id === c)).toBe(false);
    await as(ctx, admin).post(`/api/v1/trash/records/${c}/restore`).expect(200);
    expect((await listOf(admin, a)).total).toBe(3);

    await as(ctx, admin).delete(`/api/v1/folders/${filed.folderId}`).expect(204);
    expect((await listOf(admin, a)).items.some((r) => r.other.id === d)).toBe(false);
    await as(ctx, admin).post(`/api/v1/trash/folders/${filed.folderId}/restore`).expect(204);
    expect((await listOf(admin, a)).total).toBe(3);

    await as(ctx, admin).delete(`/api/v1/records/${a}`).expect(204);
    expect((await listOf(admin, b)).total).toBe(0);
    expect((await listOf(admin, c)).total).toBe(0);
    await as(ctx, admin).post(`/api/v1/trash/records/${a}/restore`).expect(200);
    expect((await listOf(admin, b)).total).toBe(1);
    expect(await rowsWith(a)).toBe(3);
  });

  it('deletes relations when either end is purged: single, folder and empty trash', async () => {
    const a = await record();
    const b = await record();
    const c = await record();
    const filed = await folder('Relations purge');
    const d = (await createRecord(ctx, admin, filed, { name: 'Purged with folder' })).id;
    await relate(admin, a, { kind: 'references', otherId: b }).expect(201);
    await relate(admin, c, { kind: 'partOf', otherId: a }).expect(201);
    await relate(admin, a, { kind: 'relatedTo', otherId: d }).expect(201);
    const e = await record();
    await relate(admin, e, { kind: 'supersedes', otherId: b }).expect(201);

    await as(ctx, admin).delete(`/api/v1/records/${b}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/trash/records/${b}`).expect(200);
    expect(await rowsWith(b)).toBe(0);
    expect(await rowsWith(a)).toBe(2);

    await as(ctx, admin).delete(`/api/v1/folders/${filed.folderId}`).expect(204);
    await as(ctx, admin).delete(`/api/v1/trash/folders/${filed.folderId}`).expect(200);
    expect(await rowsWith(d)).toBe(0);
    expect(await rowsWith(a)).toBe(1);

    await as(ctx, admin).delete(`/api/v1/records/${c}`).expect(204);
    await as(ctx, admin).delete('/api/v1/trash').expect(200);
    expect(await rowsWith(c)).toBe(0);
    expect(await rowsWith(a)).toBe(0);
    expect((await listOf(admin, a)).total).toBe(0);
  });

  it('skips a dangling row on read', async () => {
    const a = await record();
    const b = await record();
    const gone = await record();
    await relate(admin, a, { kind: 'references', otherId: b }).expect(201);
    await relate(admin, gone, { kind: 'partOf', otherId: a }).expect(201);
    await recordsModel.deleteOne({ _id: new Types.ObjectId(gone) }).exec();
    const list = await listOf(admin, a);
    expect(list.total).toBe(1);
    expect(list.items.map((r) => r.other.id)).toEqual([b]);
  });

  it('isolates tenants on every endpoint', async () => {
    const mine = await record();
    const mine2 = await record();
    const theirs = await record(other, otherWs);
    const theirs2 = await record(other, otherWs);
    const theirRelation = await relate(other, theirs, {
      kind: 'references',
      otherId: theirs2,
    }).expect(201);
    const myRelation = await relate(admin, mine, { kind: 'references', otherId: mine2 }).expect(
      201,
    );

    await as(ctx, admin).get(url(theirs)).expect(404);
    await relate(admin, theirs, { kind: 'references', otherId: mine }).expect(404);
    await relate(admin, mine, { kind: 'references', otherId: theirs }).expect(404);
    await relate(admin, mine, { kind: 'partOf', otherId: theirs, direction: 'incoming' }).expect(
      404,
    );
    await as(ctx, admin)
      .delete(`${url(theirs)}/${theirRelation.body.id}`)
      .expect(404);
    await as(ctx, admin)
      .delete(`${url(mine)}/${theirRelation.body.id}`)
      .expect(404);
    await as(ctx, other)
      .delete(`${url(mine)}/${myRelation.body.id}`)
      .expect(404);
    await as(ctx, other)
      .delete(`${url(theirs)}/${myRelation.body.id}`)
      .expect(404);

    const myList = await listOf(admin, mine);
    expect(myList.items.map((r) => r.other.id)).toEqual([mine2]);
    const theirList = await listOf(other, theirs);
    expect(theirList.items.map((r) => r.id)).toEqual([theirRelation.body.id]);
    expect(await rowsWith(theirs)).toBe(1);
    expect(await rowsWith(mine)).toBe(1);

    await ctx.http().get(url(mine)).expect(401);
    await ctx.http().post(url(mine)).send({ kind: 'references', otherId: mine2 }).expect(401);
    await ctx
      .http()
      .delete(`${url(mine)}/${myRelation.body.id}`)
      .expect(401);
  });
});
