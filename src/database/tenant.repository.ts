import { types } from 'node:util';
import type {
  HydratedDocument,
  Model,
  PipelineStage,
  QueryFilter,
  SortOrder,
  Types,
  UpdateQuery,
} from 'mongoose';
import { isObjectId, toObjectId } from './object-id.js';

export interface TenantOwned {
  tenantId: Types.ObjectId;
}

export type NewEntity<T> = Omit<T, 'tenantId' | 'createdAt' | 'updatedAt'>;

export interface FindOptions {
  sort?: Record<string, SortOrder>;
  skip?: number;
  limit?: number;
  maxTimeMS?: number;
}

const NOT_PLAIN = 'TenantRepository: an update must be a plain object';

const REBUILDING_STAGES: ReadonlySet<string> = new Set([
  '$project',
  '$replaceRoot',
  '$replaceWith',
]);

function namesTenant(path: unknown): boolean {
  return typeof path === 'string' && (path === 'tenantId' || path.startsWith('tenantId.'));
}

const MONGOOSE_MARKERS: readonly string[] = [
  '$__',
  '$isMongooseMap',
  'isMongooseBuffer',
  'isMongooseArray',
  'isMongooseDocumentArray',
];

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return holdsDataOnly(value);
}

function holdsDataOnly(value: object): boolean {
  if (MONGOOSE_MARKERS.some((marker) => Object.hasOwn(value, marker))) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => !descriptor.get && !descriptor.set && typeof descriptor.value !== 'function',
  );
}

function isPlainArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    !types.isProxy(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    holdsDataOnly(value)
  );
}

function isPlainArgument(operator: string, argument: unknown): boolean {
  if (argument === null || typeof argument !== 'object') return true;
  if (Array.isArray(argument)) return operator === '$unset' && isPlainArray(argument);
  return isPlainObject(argument);
}

function pathsOf(operator: string, argument: unknown): unknown[] {
  if (typeof argument === 'string') return [argument];
  if (Array.isArray(argument)) return argument;
  if (argument === null || typeof argument !== 'object') return [];
  const keys = Object.keys(argument);
  return operator === '$rename' ? [...keys, ...Object.values(argument)] : keys;
}

export class TenantRepository<TSchema extends TenantOwned> {
  constructor(protected readonly model: Model<TSchema>) {}

  protected assertKeepsTenant(update: UpdateQuery<TSchema> | PipelineStage[]): void {
    const parts: unknown[] = Array.isArray(update) ? update : [update];
    for (const part of parts) {
      if (!isPlainObject(part)) throw new Error(NOT_PLAIN);
      for (const [key, argument] of Object.entries(part as object)) {
        if (key.startsWith('$') && !isPlainArgument(key, argument)) {
          throw new Error(NOT_PLAIN);
        }
        const refused = key.startsWith('$')
          ? REBUILDING_STAGES.has(key) || pathsOf(key, argument).some(namesTenant)
          : namesTenant(key);
        if (refused) throw new Error('TenantRepository: an update must not change tenantId');
      }
    }
  }

  protected scope(tenantId: string, filter: QueryFilter<TSchema> = {}): QueryFilter<TSchema> {
    return {
      ...filter,
      tenantId: toObjectId(tenantId),
    } as QueryFilter<TSchema>;
  }

  protected byId(tenantId: string, id: string): QueryFilter<TSchema> {
    return this.scope(tenantId, {
      _id: toObjectId(id),
    } as QueryFilter<TSchema>);
  }

  async create(tenantId: string, data: NewEntity<TSchema>): Promise<HydratedDocument<TSchema>> {
    return this.model.create({
      ...data,
      tenantId: toObjectId(tenantId),
    } as TSchema);
  }

  async findById(tenantId: string, id: string): Promise<HydratedDocument<TSchema> | null> {
    if (!isObjectId(id)) return null;
    return this.model.findOne(this.byId(tenantId, id)).exec();
  }

  async findOne(
    tenantId: string,
    filter: QueryFilter<TSchema>,
  ): Promise<HydratedDocument<TSchema> | null> {
    return this.model.findOne(this.scope(tenantId, filter)).exec();
  }

  async find(
    tenantId: string,
    filter: QueryFilter<TSchema>,
    options: FindOptions = {},
  ): Promise<HydratedDocument<TSchema>[]> {
    let query = this.model.find(this.scope(tenantId, filter));
    if (options.sort) query = query.sort(options.sort);
    if (options.skip) query = query.skip(options.skip);
    if (options.limit) query = query.limit(options.limit);
    if (options.maxTimeMS) query = query.maxTimeMS(options.maxTimeMS);
    return query.exec();
  }

  async count(tenantId: string, filter: QueryFilter<TSchema>): Promise<number> {
    return this.model.countDocuments(this.scope(tenantId, filter)).exec();
  }

  async exists(tenantId: string, filter: QueryFilter<TSchema>): Promise<boolean> {
    return (await this.model.exists(this.scope(tenantId, filter))) !== null;
  }

  async updateById(
    tenantId: string,
    id: string,
    update: UpdateQuery<TSchema>,
  ): Promise<HydratedDocument<TSchema> | null> {
    this.assertKeepsTenant(update);
    if (!isObjectId(id)) return null;
    return this.model
      .findOneAndUpdate(this.byId(tenantId, id), update, {
        returnDocument: 'after',
        runValidators: true,
      })
      .exec();
  }

  async updateOne(
    tenantId: string,
    filter: QueryFilter<TSchema>,
    update: UpdateQuery<TSchema>,
  ): Promise<HydratedDocument<TSchema> | null> {
    this.assertKeepsTenant(update);
    return this.model
      .findOneAndUpdate(this.scope(tenantId, filter), update, {
        returnDocument: 'after',
        runValidators: true,
      })
      .exec();
  }

  async updateMany(
    tenantId: string,
    filter: QueryFilter<TSchema>,
    update: UpdateQuery<TSchema> | PipelineStage[],
  ): Promise<number> {
    this.assertKeepsTenant(update);
    const result = await this.model
      .updateMany(this.scope(tenantId, filter), update as UpdateQuery<TSchema>, {
        updatePipeline: Array.isArray(update),
      })
      .exec();
    return result.modifiedCount;
  }

  async upsertOne(
    tenantId: string,
    filter: QueryFilter<TSchema>,
    update: UpdateQuery<TSchema>,
  ): Promise<void> {
    this.assertKeepsTenant(update);
    await this.model
      .updateOne(this.scope(tenantId, filter), update, { upsert: true, runValidators: true })
      .exec();
  }

  async findOneAndDelete(
    tenantId: string,
    filter: QueryFilter<TSchema>,
  ): Promise<HydratedDocument<TSchema> | null> {
    return this.model.findOneAndDelete(this.scope(tenantId, filter)).exec();
  }

  async deleteById(tenantId: string, id: string): Promise<boolean> {
    if (!isObjectId(id)) return false;
    const result = await this.model.deleteOne(this.byId(tenantId, id)).exec();
    return result.deletedCount === 1;
  }

  async deleteMany(tenantId: string, filter: QueryFilter<TSchema>): Promise<number> {
    const result = await this.model.deleteMany(this.scope(tenantId, filter)).exec();
    return result.deletedCount;
  }

  async distinct<K extends string>(
    tenantId: string,
    field: K,
    filter: QueryFilter<TSchema>,
  ): Promise<unknown[]> {
    return this.model.distinct(field, this.scope(tenantId, filter)).exec();
  }

  async aggregate<TResult>(
    tenantId: string,
    filter: QueryFilter<TSchema>,
    stages: PipelineStage[],
  ): Promise<TResult[]> {
    return this.model
      .aggregate<TResult>([{ $match: this.scope(tenantId, filter) }, ...stages] as PipelineStage[])
      .exec();
  }

  async aggregateSum(
    tenantId: string,
    field: string,
    filter: QueryFilter<TSchema> = {},
  ): Promise<number> {
    const [result] = await this.model
      .aggregate<{ total: number }>([
        { $match: this.scope(tenantId, filter) },
        { $group: { _id: null, total: { $sum: `$${field}` } } },
      ])
      .exec();
    return result?.total ?? 0;
  }
}
