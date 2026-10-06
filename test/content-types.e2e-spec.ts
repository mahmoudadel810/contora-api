import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { ContentTypesRepository } from '../src/content-types/content-types.repository.js';
import { RecordsRepository } from '../src/records/records.repository.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { grantRootEdit } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const invoiceType = {
  name: 'Invoice',
  description: 'Supplier invoices',
  fields: [
    { key: 'supplier', label: 'Supplier', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'number', required: true, min: 0 },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: ['Open', 'Paid'],
      defaultValue: 'Open',
    },
  ],
};

describe('content types (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let member: Actor;
  let other: Actor;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Types Co' });
    member = await addMember(ctx, admin);
    await grantRootEdit(ctx, admin, member);
    other = await signUp(ctx, { tenantName: 'Other Co' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('creates, reads, lists and updates a content type, bumping schemaVersion only when fields change', async () => {
    const created = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send(invoiceType)
      .expect(201);
    expect(created.body).toMatchObject({ name: 'Invoice', schemaVersion: 1, status: 'active' });
    expect(created.body.fields[2]).toEqual({
      key: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: ['Open', 'Paid'],
      defaultValue: 'Open',
    });

    const fetched = await as(ctx, member)
      .get(`/api/v1/content-types/${created.body.id}`)
      .expect(200);
    expect(fetched.body.id).toBe(created.body.id);

    const renamed = await as(ctx, admin)
      .patch(`/api/v1/content-types/${created.body.id}`)
      .send({ ...invoiceType, name: 'Supplier Invoice' })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: 'Supplier Invoice', schemaVersion: 1 });

    const extended = await as(ctx, admin)
      .patch(`/api/v1/content-types/${created.body.id}`)
      .send({
        ...invoiceType,
        name: 'Supplier Invoice',
        fields: [
          ...invoiceType.fields,
          { key: 'paidOn', label: 'Paid on', type: 'date', required: false },
        ],
      })
      .expect(200);
    expect(extended.body.schemaVersion).toBe(2);
    expect(extended.body.fields).toHaveLength(4);

    const list = await as(ctx, member).get('/api/v1/content-types').expect(200);
    expect(list.body.map((t: { name: string }) => t.name)).toContain('Supplier Invoice');
  });

  it('archives and unarchives, and filters the list by status', async () => {
    const created = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ ...invoiceType, name: 'Receipt' })
      .expect(201);
    const archived = await as(ctx, admin)
      .post(`/api/v1/content-types/${created.body.id}/archive`)
      .expect(200);
    expect(archived.body.status).toBe('archived');
    const active = await as(ctx, admin).get('/api/v1/content-types?status=active').expect(200);
    expect(active.body.map((t: { id: string }) => t.id)).not.toContain(created.body.id);
    const onlyArchived = await as(ctx, admin)
      .get('/api/v1/content-types?status=archived')
      .expect(200);
    expect(onlyArchived.body.map((t: { id: string }) => t.id)).toEqual([created.body.id]);
    const restored = await as(ctx, admin)
      .post(`/api/v1/content-types/${created.body.id}/unarchive`)
      .expect(200);
    expect(restored.body.status).toBe('active');
  });

  it('deletes an unused type but refuses when records use it', async () => {
    const unused = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ ...invoiceType, name: 'Unused' })
      .expect(201);
    await as(ctx, admin).delete(`/api/v1/content-types/${unused.body.id}`).expect(204);
    await as(ctx, admin).get(`/api/v1/content-types/${unused.body.id}`).expect(404);

    const used = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ ...invoiceType, name: 'Used' })
      .expect(201);
    await ctx.app
      .get<Connection>(getConnectionToken())
      .collection('records')
      .insertOne({
        tenantId: new Types.ObjectId(admin.tenantId),
        contentTypeId: new Types.ObjectId(used.body.id),
      });
    const refused = await as(ctx, admin)
      .delete(`/api/v1/content-types/${used.body.id}`)
      .expect(409);
    expect(refused.body.code).toBe('CONTENT_TYPE_IN_USE');
  });

  describe('delete racing record creation', () => {
    const recordsOf = (typeId: string) =>
      ctx.app
        .get<Connection>(getConnectionToken())
        .collection('records')
        .countDocuments({ contentTypeId: new Types.ObjectId(typeId) });
    const createRecordOf = (typeId: string, folderId: string) =>
      as(ctx, member)
        .post('/api/v1/records')
        .send({ name: 'Racing record', contentTypeId: typeId, folderId, metadata: {} });
    const simpleType = (name: string) =>
      as(ctx, admin)
        .post('/api/v1/content-types')
        .send({ name, fields: [{ key: 'note', label: 'Note', type: 'text', required: false }] })
        .expect(201);

    it('undoes a record created while its type was deleted', async () => {
      const type = await simpleType('Deleted during create');
      const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
      const repository = ctx.app.get(RecordsRepository);
      const createWithId = repository.createWithId.bind(repository);
      const spy = vi.spyOn(repository, 'createWithId').mockImplementationOnce(async (...args) => {
        await as(ctx, admin).delete(`/api/v1/content-types/${type.body.id}`).expect(204);
        return createWithId(...args);
      });
      let res: { status: number; body: { code?: string } };
      try {
        res = await createRecordOf(type.body.id, root.body.folder.id);
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(404);
      expect(await recordsOf(type.body.id)).toBe(0);
    });

    it('refuses a record while its type is being deleted, and the delete goes through', async () => {
      const type = await simpleType('Create during delete');
      const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
      const repository = ctx.app.get(ContentTypesRepository);
      const deleteById = repository.deleteById.bind(repository);
      const deleteMany = repository.deleteMany.bind(repository);
      let created = 0;
      const race = async () => {
        created = (await createRecordOf(type.body.id, root.body.folder.id)).status;
      };
      const byId = vi.spyOn(repository, 'deleteById').mockImplementationOnce(async (...args) => {
        await race();
        return deleteById(...args);
      });
      const many = vi.spyOn(repository, 'deleteMany').mockImplementationOnce(async (...args) => {
        await race();
        return deleteMany(...args);
      });
      try {
        await as(ctx, admin).delete(`/api/v1/content-types/${type.body.id}`).expect(204);
      } finally {
        byId.mockRestore();
        many.mockRestore();
      }
      expect(created).toBe(409);
      expect(await recordsOf(type.body.id)).toBe(0);
      await as(ctx, admin).get(`/api/v1/content-types/${type.body.id}`).expect(404);
    });

    it('does not delete a type once its mark went stale and a record arrived meanwhile', async () => {
      const type = await simpleType('Stalled delete');
      const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
      const connection = ctx.app.get<Connection>(getConnectionToken());
      const collection = connection.collection.bind(connection);
      let created = 0;
      const spy = vi.spyOn(connection, 'collection').mockImplementationOnce((name: string) => {
        const real = collection(name);
        return {
          countDocuments: async (...args: Parameters<typeof real.countDocuments>) => {
            const count = await real.countDocuments(...args);
            await collection('content_types').updateOne(
              { _id: new Types.ObjectId(type.body.id) },
              { $set: { deleteClaimedAt: new Date(Date.now() - 31_000) } },
            );
            created = (await createRecordOf(type.body.id, root.body.folder.id)).status;
            return count;
          },
        } as unknown as ReturnType<typeof collection>;
      });
      let res: { status: number; body: { code?: string } };
      try {
        res = await as(ctx, admin).delete(`/api/v1/content-types/${type.body.id}`);
      } finally {
        spy.mockRestore();
      }
      expect(created).toBe(201);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTENT_TYPE_DELETING');
      await as(ctx, admin).get(`/api/v1/content-types/${type.body.id}`).expect(200);
      expect(await recordsOf(type.body.id)).toBe(1);
    });

    it('lets a record through when the delete is refused, and recovers a stale delete mark', async () => {
      const type = await simpleType('Crashed delete');
      const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
      const types = ctx.app.get<Connection>(getConnectionToken()).collection('content_types');
      await types.updateOne(
        { _id: new Types.ObjectId(type.body.id) },
        { $set: { deleteToken: 'crashed', deleteClaimedAt: new Date(Date.now() - 31_000) } },
      );
      expect((await createRecordOf(type.body.id, root.body.folder.id)).status).toBe(201);
      const refused = await as(ctx, admin)
        .delete(`/api/v1/content-types/${type.body.id}`)
        .expect(409);
      expect(refused.body.code).toBe('CONTENT_TYPE_IN_USE');
      const mark = await types.findOne({ _id: new Types.ObjectId(type.body.id) });
      expect(mark?.deleteToken).toBeNull();
      expect((await createRecordOf(type.body.id, root.body.folder.id)).status).toBe(201);
      await types.updateOne(
        { _id: new Types.ObjectId(type.body.id) },
        { $set: { deleteToken: 'running', deleteClaimedAt: new Date() } },
      );
      const blocked = await createRecordOf(type.body.id, root.body.folder.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('CONTENT_TYPE_DELETING');
      const busy = await as(ctx, admin).delete(`/api/v1/content-types/${type.body.id}`).expect(409);
      expect(busy.body.code).toBe('CONTENT_TYPE_DELETING');
    });
  });

  it('validates field definitions with per-field paths', async () => {
    const res = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({
        name: 'Broken',
        fields: [
          { key: 'Bad Key', label: 'x', type: 'text', required: false },
          { key: 'pick', label: 'Pick', type: 'select', required: false },
          { key: 'n', label: 'N', type: 'number', required: false, min: 9, max: 1 },
          { key: 'weird', label: 'W', type: 'rich-text', required: false },
          { key: 'num', label: 'Num', type: 'number', required: false, defaultValue: 'ten' },
        ],
      })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    const paths = (res.body.details as Array<{ path: string }>).map((d) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'fields.0.key',
        'fields.1.options',
        'fields.2.min',
        'fields.3.type',
        'fields.4.defaultValue',
      ]),
    );
  });

  it('rejects duplicate field keys and names that differ only by case', async () => {
    const dupKeys = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({
        name: 'Duplicated',
        fields: [
          { key: 'n', label: 'N', type: 'number', required: false },
          { key: 'n', label: 'N again', type: 'text', required: false },
        ],
      })
      .expect(400);
    expect((dupKeys.body.details as Array<{ path: string }>).map((d) => d.path)).toContain(
      'fields.1.key',
    );
    await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ ...invoiceType, name: 'Contract' })
      .expect(201);
    const dup = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ ...invoiceType, name: '  contract ' })
      .expect(409);
    expect(dup.body.code).toBe('NAME_TAKEN');
  });

  it('lets Members read but not manage, and records ACCESS_DENIED', async () => {
    await as(ctx, member).get('/api/v1/content-types').expect(200);
    await as(ctx, member)
      .post('/api/v1/content-types')
      .send({ ...invoiceType, name: 'Member Type' })
      .expect(403);
    const audit = await as(ctx, admin).get('/api/v1/audit?action=ACCESS_DENIED').expect(200);
    expect(
      audit.body.items.some(
        (e: { actor: { id: string }; context: { attemptedAction: string } }) =>
          e.actor.id === member.userId && e.context.attemptedAction === 'contentTypes.manage',
      ),
    ).toBe(true);
  });

  it('isolates content types between tenants and 404s malformed ids', async () => {
    await as(ctx, admin).get('/api/v1/content-types/not-an-id').expect(404);
    const mine = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ ...invoiceType, name: 'Private' })
      .expect(201);
    await as(ctx, other).get(`/api/v1/content-types/${mine.body.id}`).expect(404);
    await as(ctx, other)
      .patch(`/api/v1/content-types/${mine.body.id}`)
      .send({ ...invoiceType, name: 'Stolen' })
      .expect(404);
    await as(ctx, other).post(`/api/v1/content-types/${mine.body.id}/archive`).expect(404);
    await as(ctx, other).delete(`/api/v1/content-types/${mine.body.id}`).expect(404);
    const list = await as(ctx, other).get('/api/v1/content-types').expect(200);
    expect(list.body).toEqual([]);
  });

  it('never unarchives another tenant’s content type', async () => {
    const mine = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ ...invoiceType, name: 'Archived elsewhere' })
      .expect(201);
    await as(ctx, admin).post(`/api/v1/content-types/${mine.body.id}/archive`).expect(200);
    const refused = await as(ctx, other)
      .post(`/api/v1/content-types/${mine.body.id}/unarchive`)
      .expect(404);
    expect(refused.body.code).toBe('NOT_FOUND');
    const still = await as(ctx, admin).get(`/api/v1/content-types/${mine.body.id}`).expect(200);
    expect(still.body.status).toBe('archived');
    const audit = await as(ctx, other)
      .get('/api/v1/audit?action=CONTENT_TYPE_UNARCHIVED')
      .expect(200);
    expect(audit.body.total).toBe(0);
  });
});
