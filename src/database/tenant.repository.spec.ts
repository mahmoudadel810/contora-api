import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, {
  type Model,
  type PipelineStage,
  Schema,
  Types,
  type UpdateQuery,
} from 'mongoose';
import { TenantRepository } from './tenant.repository.js';

interface Note {
  tenantId: Types.ObjectId;
  title: string;
  hits?: number;
  meta?: { owner?: Types.ObjectId; seenAt?: Date };
  tags?: string[];
  refs?: Types.ObjectId[];
  label?: string;
}

const NoteSchema = new Schema<Note>({
  tenantId: { type: Schema.Types.ObjectId, required: true },
  title: String,
  hits: Number,
  meta: { owner: Schema.Types.ObjectId, seenAt: Date },
  tags: [String],
  refs: [Schema.Types.ObjectId],
  label: String,
});

describe('TenantRepository', () => {
  let mongo: MongoMemoryServer;
  let notes: Model<Note>;
  let repo: TenantRepository<Note>;
  const tenantA = new Types.ObjectId().toHexString();
  const tenantB = new Types.ObjectId().toHexString();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri('repo_test'));
    notes = mongoose.model<Note>('Note', NoteSchema);
    repo = new TenantRepository(notes);
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('stamps the tenant on create and finds only within that tenant', async () => {
    const created = await repo.create(tenantA, { title: 'a1' });
    expect(created.tenantId.toHexString()).toBe(tenantA);
    expect(await repo.findById(tenantA, created.id)).not.toBeNull();
    expect(await repo.findById(tenantB, created.id)).toBeNull();
  });

  it('returns null for a malformed id instead of throwing', async () => {
    expect(await repo.findById(tenantA, 'not-an-id')).toBeNull();
    expect(await repo.updateById(tenantA, 'not-an-id', { title: 'x' })).toBeNull();
    expect(await repo.deleteById(tenantA, 'not-an-id')).toBe(false);
  });

  it('cannot update or delete across tenants', async () => {
    const created = await repo.create(tenantA, { title: 'keep' });
    expect(await repo.updateById(tenantB, created.id, { title: 'changed' })).toBeNull();
    expect(await repo.deleteById(tenantB, created.id)).toBe(false);
    expect((await repo.findById(tenantA, created.id))?.title).toBe('keep');
  });

  it('counts and lists per tenant with a caller filter merged in', async () => {
    await repo.create(tenantB, { title: 'b1' });
    await repo.create(tenantB, { title: 'b2' });
    expect(await repo.count(tenantB, {})).toBe(2);
    expect(await repo.count(tenantB, { title: 'b1' })).toBe(1);
    const listed = await repo.find(tenantB, {}, { sort: { title: -1 }, limit: 1 });
    expect(listed.map((n) => n.title)).toEqual(['b2']);
  });

  it('ignores a tenantId smuggled into the filter', async () => {
    const smuggled = await repo.find(tenantB, { tenantId: new Types.ObjectId(tenantA) }, {});
    expect(smuggled.every((n) => n.tenantId.toHexString() === tenantB)).toBe(true);
    expect(smuggled.length).toBe(2);
  });

  it('aggregates only within the tenant, even with a tenantId smuggled into the match', async () => {
    const own = new Types.ObjectId().toHexString();
    const other = new Types.ObjectId().toHexString();
    await repo.create(own, { title: 'agg', hits: 2 });
    await repo.create(own, { title: 'agg', hits: 3 });
    await repo.create(other, { title: 'agg', hits: 100 });
    const rows = await repo.aggregate<{ _id: string; total: number }>(
      own,
      { title: 'agg', tenantId: new Types.ObjectId(other) },
      [{ $group: { _id: '$title', total: { $sum: '$hits' } } }],
    );
    expect(rows).toEqual([{ _id: 'agg', total: 5 }]);
  });

  it('finds and deletes one document only within the tenant', async () => {
    const own = new Types.ObjectId().toHexString();
    const other = new Types.ObjectId().toHexString();
    const created = await repo.create(own, { title: 'doomed' });
    expect(await repo.findOneAndDelete(other, { _id: created._id })).toBeNull();
    expect(await repo.findById(own, created.id)).not.toBeNull();
    const deleted = await repo.findOneAndDelete(own, { _id: created._id });
    expect(deleted?.title).toBe('doomed');
    expect(await repo.findById(own, created.id)).toBeNull();
  });

  it('upserts one row per filter, stamped with the tenant and invisible to others', async () => {
    const own = new Types.ObjectId().toHexString();
    const other = new Types.ObjectId().toHexString();
    await repo.upsertOne(own, { title: 'seen' }, { $set: { hits: 1 } });
    await repo.upsertOne(own, { title: 'seen' }, { $set: { hits: 2 } });
    const rows = await repo.find(own, { title: 'seen' });
    expect(rows.map((n) => [n.tenantId.toHexString(), n.hits])).toEqual([[own, 2]]);
    expect(await repo.count(other, { title: 'seen' })).toBe(0);
    await repo.upsertOne(other, { title: 'seen' }, { $set: { hits: 9 } });
    expect((await repo.findOne(own, { title: 'seen' }))?.hits).toBe(2);
  });

  describe('refuses an update that names tenantId', () => {
    const refused = 'TenantRepository: an update must not change tenantId';

    it('in $set', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by $set' });
      await expect(
        repo.updateOne(own, { _id: created._id }, { $set: { tenantId: other } }),
      ).rejects.toThrow(refused);
      expect(await repo.findById(own, created.id)).not.toBeNull();
    });

    it('in $setOnInsert when the upsert inserts', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      await expect(
        repo.upsertOne(
          own,
          { title: 'inserted elsewhere' },
          { $set: { hits: 1 }, $setOnInsert: { tenantId: other } },
        ),
      ).rejects.toThrow(refused);
      expect(await repo.count(other.toHexString(), { title: 'inserted elsewhere' })).toBe(0);
    });

    it('as a top-level key', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by replacement' });
      await expect(repo.updateById(own, created.id, { tenantId: other })).rejects.toThrow(refused);
      expect(await repo.findById(own, created.id)).not.toBeNull();
    });

    it('as the key or the target of $rename', async () => {
      const own = new Types.ObjectId().toHexString();
      const created = await repo.create(own, { title: 'renamed' });
      await expect(
        repo.updateMany(own, { _id: created._id }, { $rename: { tenantId: 'formerTenant' } }),
      ).rejects.toThrow(refused);
      await expect(
        repo.updateOne(own, { _id: created._id }, { $rename: { title: 'tenantId' } }),
      ).rejects.toThrow(refused);
      expect((await repo.findById(own, created.id))?.title).toBe('renamed');
    });
  });

  describe('refuses an update that is not a plain object', () => {
    const refused = 'TenantRepository: an update must be a plain object';

    function intruderFor(id: Types.ObjectId, tenantId: Types.ObjectId, title: string) {
      return notes.hydrate({ _id: id, tenantId, title }) as unknown as UpdateQuery<Note>;
    }

    it('as the whole update to updateOne', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by a document' });
      await expect(
        repo.updateOne(own, { _id: created._id }, intruderFor(created._id, other, 'moved')),
      ).rejects.toThrow(refused);
      expect((await repo.findById(own, created.id))?.title).toBe('moved by a document');
      expect(await repo.findById(other.toHexString(), created.id)).toBeNull();
    });

    it('as the whole update to upsertOne', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'upserted by a document' });
      await expect(
        repo.upsertOne(own, { _id: created._id }, intruderFor(created._id, other, 'moved')),
      ).rejects.toThrow(refused);
      expect((await repo.findById(own, created.id))?.title).toBe('upserted by a document');
      expect(await repo.findById(other.toHexString(), created.id)).toBeNull();
    });

    it('as the value of an operator', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by $set of a document' });
      await expect(
        repo.updateOne(own, { _id: created._id }, {
          $set: intruderFor(created._id, other, 'moved'),
        } as UpdateQuery<Note>),
      ).rejects.toThrow(refused);
      expect(await repo.findById(own, created.id)).not.toBeNull();
    });

    it('as a pipeline stage', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by a stage' });
      const stage = intruderFor(created._id, other, 'moved') as unknown as PipelineStage;
      await expect(repo.updateMany(own, { _id: created._id }, [stage])).rejects.toThrow(refused);
      expect(await repo.findById(own, created.id)).not.toBeNull();
    });

    function lookalikeFor(id: Types.ObjectId, tenantId: Types.ObjectId, title: string) {
      return {
        $__: {},
        toObject: () => ({ _id: id, tenantId, title }),
      } as unknown as UpdateQuery<Note>;
    }

    it('as a document lookalike for the whole update to updateOne', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by a lookalike' });
      await expect(
        repo.updateOne(own, { _id: created._id }, lookalikeFor(created._id, other, 'moved')),
      ).rejects.toThrow(refused);
      expect(await repo.findById(other.toHexString(), created.id)).toBeNull();
      expect((await repo.findById(own, created.id))?.title).toBe('moved by a lookalike');
    });

    it('as a document lookalike for the value of $set', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by $set of a lookalike' });
      await expect(
        repo.updateOne(own, { _id: created._id }, {
          $set: lookalikeFor(created._id, other, 'moved'),
        } as UpdateQuery<Note>),
      ).rejects.toThrow(refused);
      expect(await repo.findById(other.toHexString(), created.id)).toBeNull();
      expect((await repo.findById(own, created.id))?.title).toBe('moved by $set of a lookalike');
    });

    it('as a document lookalike for the whole update to upsertOne', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'upserted by a lookalike' });
      await expect(
        repo.upsertOne(own, { _id: created._id }, lookalikeFor(created._id, other, 'moved')),
      ).rejects.toThrow(refused);
      expect(await repo.findById(other.toHexString(), created.id)).toBeNull();
      expect((await repo.findById(own, created.id))?.title).toBe('upserted by a lookalike');
    });

    it('as a document lookalike for a $unset list', async () => {
      const own = new Types.ObjectId().toHexString();
      const created = await repo.create(own, { title: 'stripped by a lookalike list' });
      const list = Object.assign(['title'], { $__: {}, toObject: () => ({ tenantId: 1 }) });
      await expect(
        repo.updateOne(own, { _id: created._id }, { $unset: list } as UpdateQuery<Note>),
      ).rejects.toThrow(refused);
      expect((await repo.findById(own, created.id))?.title).toBe('stripped by a lookalike list');
    });

    function proxyFor<T extends object>(target: T, unwrapped: object): T {
      return new Proxy(target, {
        get: (t, key) =>
          key === '$__' ? {} : key === 'toObject' ? () => unwrapped : Reflect.get(t, key),
      });
    }

    it('as a Proxy for the whole update to updateOne', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by a proxy' });
      const update = proxyFor(
        { title: 'x' },
        { _id: created._id, tenantId: other, title: 'moved' },
      );
      await expect(repo.updateOne(own, { _id: created._id }, update)).rejects.toThrow(refused);
      expect(await repo.findById(other.toHexString(), created.id)).toBeNull();
      expect((await repo.findById(own, created.id))?.title).toBe('moved by a proxy');
    });

    it('as a Proxy for the value of $set', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'moved by $set of a proxy' });
      const $set = proxyFor({ title: 'x' }, { _id: created._id, tenantId: other, title: 'moved' });
      await expect(
        repo.updateOne(own, { _id: created._id }, { $set } as UpdateQuery<Note>),
      ).rejects.toThrow(refused);
      expect(await repo.findById(other.toHexString(), created.id)).toBeNull();
      expect((await repo.findById(own, created.id))?.title).toBe('moved by $set of a proxy');
    });

    it('as a Proxy array for a $unset list', async () => {
      const own = new Types.ObjectId().toHexString();
      const other = new Types.ObjectId();
      const created = await repo.create(own, { title: 'stripped by a proxy list' });
      const $unset = proxyFor(['title'], { tenantId: 1 });
      await expect(
        repo.updateOne(own, { _id: created._id }, { $unset } as UpdateQuery<Note>),
      ).rejects.toThrow(refused);
      expect(await repo.findById(other.toHexString(), created.id)).toBeNull();
      expect((await repo.findById(own, created.id))?.title).toBe('stripped by a proxy list');
    });

    it('as a $unset list carrying a Mongoose array marker', async () => {
      const own = new Types.ObjectId().toHexString();
      const created = await repo.create(own, { title: 'marked list' });
      const $unset = Object.assign(['title'], { isMongooseArray: true });
      await expect(
        repo.updateOne(own, { _id: created._id }, { $unset } as UpdateQuery<Note>),
      ).rejects.toThrow(refused);
      expect((await repo.findById(own, created.id))?.title).toBe('marked list');
    });

    it('as a $unset list carrying a Mongoose document-array marker', async () => {
      const own = new Types.ObjectId().toHexString();
      const created = await repo.create(own, { title: 'marked document list' });
      const $unset = Object.assign(['title'], { isMongooseDocumentArray: true });
      await expect(
        repo.updateOne(own, { _id: created._id }, { $unset } as UpdateQuery<Note>),
      ).rejects.toThrow(refused);
      expect((await repo.findById(own, created.id))?.title).toBe('marked document list');
    });

    it('as an array where an operator takes an object', async () => {
      const own = new Types.ObjectId().toHexString();
      const created = await repo.create(own, { title: 'array operator' });
      await expect(
        repo.updateOne(own, { _id: created._id }, { $set: ['title'] } as UpdateQuery<Note>),
      ).rejects.toThrow(refused);
    });

    it('but still takes a $unset list inside a pipeline', async () => {
      const own = new Types.ObjectId().toHexString();
      const created = await repo.create(own, { title: 'unset', hits: 4 });
      expect(await repo.updateMany(own, { _id: created._id }, [{ $unset: ['hits'] }])).toBe(1);
      const after = await repo.findById(own, created.id);
      expect(after?.hits).toBeUndefined();
      expect(after?.tenantId.toHexString()).toBe(own);
    });
  });

  it('still applies an ordinary update and keeps the tenant stamp', async () => {
    const own = new Types.ObjectId().toHexString();
    const created = await repo.create(own, { title: 'plain', hits: 1 });
    const updated = await repo.updateOne(
      own,
      { _id: created._id },
      { $set: { title: 'plainer' }, $inc: { hits: 2 } },
    );
    expect(updated?.title).toBe('plainer');
    expect(updated?.hits).toBe(3);
    expect(updated?.tenantId.toHexString()).toBe(own);
  });

  it('still takes ObjectId and Date values, $in, $each, $addToSet, $cond and $unset', async () => {
    const own = new Types.ObjectId().toHexString();
    const owner = new Types.ObjectId();
    const ref = new Types.ObjectId();
    const seenAt = new Date('2026-09-29T00:00:00Z');
    const created = await repo.create(own, { title: 'shapes', hits: 5, tags: ['a', 'b', 'c'] });
    const byId = { _id: created._id };

    await repo.updateOne(own, byId, { $set: { meta: { owner, seenAt } } });
    await repo.updateOne(own, byId, { $pull: { tags: { $in: ['a', 'b'] } } });
    await repo.updateOne(own, byId, { $push: { tags: { $each: ['d', 'e'] } } });
    await repo.upsertOne(own, byId, { $addToSet: { refs: ref } });
    await repo.updateMany(own, byId, [
      { $set: { label: { $cond: [{ $gt: ['$hits', 3] }, 'many', 'few'] } } },
    ]);
    let after = await repo.findById(own, created.id);
    expect(after?.meta?.owner?.toHexString()).toBe(owner.toHexString());
    expect(after?.meta?.seenAt?.toISOString()).toBe(seenAt.toISOString());
    expect([...(after?.tags ?? [])]).toEqual(['c', 'd', 'e']);
    expect(after?.refs?.map((r) => r.toHexString())).toEqual([ref.toHexString()]);
    expect(after?.label).toBe('many');

    await repo.updateMany(own, byId, [{ $unset: 'label' }]);
    await repo.updateMany(own, byId, [{ $unset: ['hits', 'meta'] }]);
    after = await repo.findById(own, created.id);
    expect(after?.label).toBeUndefined();
    expect(after?.hits).toBeUndefined();
    expect(after?.meta?.owner).toBeUndefined();
    expect(after?.tenantId.toHexString()).toBe(own);
  });
});
