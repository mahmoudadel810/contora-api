import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Types, type Model } from 'mongoose';
import type { AiExtractionJob } from './ai-extraction-job.schema.js';
import { ExtractionJobsRepository } from './ai-extraction-jobs.repository.js';

function recordingModel() {
  const calls: Array<{ method: string; filter: Record<string, unknown> }> = [];
  const chain = (result: unknown) => {
    const query = {
      sort: () => query,
      skip: () => query,
      limit: () => query,
      lean: () => query,
      exec: () => Promise.resolve(result),
    };
    return query;
  };
  const record =
    (method: string, result: unknown) =>
    (filter: Record<string, unknown> = {}) => {
      calls.push({ method, filter });
      return chain(result);
    };
  const model = {
    find: record('find', []),
    findOne: record('findOne', null),
    countDocuments: record('countDocuments', 0),
    exists: record('exists', null),
    findOneAndUpdate: record('findOneAndUpdate', null),
    updateMany: record('updateMany', { modifiedCount: 0 }),
    deleteMany: record('deleteMany', { deletedCount: 0 }),
    findOneAndDelete: record('findOneAndDelete', null),
    create: (data: unknown) => Promise.resolve(data),
  };
  return { model: model as unknown as Model<AiExtractionJob>, calls };
}

const TENANT = new Types.ObjectId().toHexString();
const USER = new Types.ObjectId().toHexString();
const OWNER = { tenantId: TENANT, userId: USER };

describe('ExtractionJobsRepository', () => {
  it('scopes every owner and tenant query by tenantId; only housekeepingBatch is unscoped', async () => {
    const { model, calls } = recordingModel();
    const jobs = new ExtractionJobsRepository(model);
    const id = new Types.ObjectId();
    const row = { _id: id, tenantId: new Types.ObjectId(TENANT), userId: new Types.ObjectId(USER) };

    await jobs.findById(OWNER, id.toHexString());
    await jobs.findOne(OWNER, { status: 'ready' });
    await jobs.find(OWNER, {});
    await jobs.count(OWNER, { status: 'queued' });
    await jobs.updateOne(OWNER, { _id: id }, { $set: { status: 'failed' } });
    await jobs.updateMany(OWNER, {}, { $set: { status: 'discarded' } });
    await jobs.deleteMany(OWNER, { _id: id });
    await jobs.countInTenant(TENANT, { status: 'queued' });
    await jobs.isRecordBound(TENANT, id);
    await jobs.findForRecords(TENANT, [id]);
    await jobs.deleteForRecords(TENANT, [id]);
    await jobs.updateRow(row, { status: 'ready' }, { $set: { status: 'expired' } });

    const scoped = calls.splice(0);
    expect(scoped.length).toBeGreaterThanOrEqual(12);
    for (const call of scoped) {
      expect(String(call.filter['tenantId'])).toBe(TENANT);
    }
    const ownerPaths = scoped.filter((call) => call.filter['userId'] !== undefined);
    for (const call of ownerPaths) expect(String(call.filter['userId'])).toBe(USER);

    await jobs.housekeepingBatch({ pass: 'interrupted' }, 200);
    await jobs.housekeepingBatch({ pass: 'expired', now: new Date() }, 200, id);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe('find');
      expect(JSON.stringify(call.filter)).not.toContain('tenantId');
    }
  });

  it('re-scopes updateRow by the row, whatever the filter claims', async () => {
    const { model, calls } = recordingModel();
    const jobs = new ExtractionJobsRepository(model);
    const row = {
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(TENANT),
      userId: new Types.ObjectId(USER),
    };
    const otherTenant = new Types.ObjectId();
    await jobs.updateRow(row, { tenantId: otherTenant, _id: new Types.ObjectId() } as never, {
      $set: { status: 'expired' },
    });
    expect(String(calls[0]?.filter['tenantId'])).toBe(TENANT);
    expect(String(calls[0]?.filter['_id'])).toBe(row._id.toHexString());
  });

  it('is the only file of the feature that touches a Mongoose model or raw collection', () => {
    const dir = new URL('.', import.meta.url).pathname;
    const sources = readdirSync(dir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
    );
    const offenders = sources.filter((name) => {
      if (name === 'ai-extraction-jobs.repository.ts' || name === 'extraction-readers.ts') {
        return false;
      }
      const text = readFileSync(join(dir, name), 'utf8');
      return /InjectModel|InjectConnection|\.collection\(|Model</.test(text);
    });
    expect(offenders).toEqual([]);
    const repository = readFileSync(join(dir, 'ai-extraction-jobs.repository.ts'), 'utf8');
    const uses = (repository.match(/this\.jobs\s*\.\w+/g) ?? []).map((use) =>
      use.replace(/\s+/g, ''),
    );
    expect(uses).toEqual(['this.jobs.create', 'this.jobs.find']);
  });
});
