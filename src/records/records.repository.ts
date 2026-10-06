import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  Model,
  type HydratedDocument,
  type QueryFilter,
  type SortOrder,
  type Types,
  type UpdateQuery,
} from 'mongoose';
import { TenantRepository, type NewEntity } from '../database/tenant.repository.js';
import { toObjectId } from '../database/object-id.js';
import { RecordEntity, type RecordDocument } from './record.schema.js';
import { RecordVersion, type RecordVersionDocument } from './record-version.schema.js';
import { staleKeysFilter } from './search-keys.js';

export interface BackfillRow {
  _id: Types.ObjectId;
  searchText?: unknown;
  metadata?: unknown;
  currentVersion?: unknown;
  search?: unknown;
  contentText?: unknown;
}

const DERIVED_PREFIX = 'search.';

@Injectable()
export class RecordsRepository extends TenantRepository<RecordEntity> {
  constructor(@InjectModel(RecordEntity.name) model: Model<RecordEntity>) {
    super(model);
  }

  createWithId(
    tenantId: string,
    id: Types.ObjectId,
    data: NewEntity<RecordEntity>,
  ): Promise<RecordDocument> {
    return this.model.create({ ...data, _id: id, tenantId: toObjectId(tenantId) });
  }

  async page(
    tenantId: string,
    filter: QueryFilter<RecordEntity>,
    sort: Record<string, SortOrder>,
    skip: number,
    limit: number,
    options: { maxTimeMS?: number } = {},
  ): Promise<{ items: HydratedDocument<RecordEntity>[]; total: number }> {
    const scoped = this.scope(tenantId, filter);
    let find = this.model.find(scoped).sort(sort).skip(skip).limit(limit);
    let count = this.model.countDocuments(scoped);
    if (options.maxTimeMS) {
      find = find.maxTimeMS(options.maxTimeMS);
      count = count.maxTimeMS(options.maxTimeMS);
    }
    const [items, total] = await Promise.all([find.exec(), count.exec()]);
    return { items, total };
  }

  async backfillPage(
    tenantId: string,
    afterId: Types.ObjectId | null,
    limit: number,
    options: { all?: boolean } = {},
  ): Promise<BackfillRow[]> {
    const after: QueryFilter<RecordEntity> = afterId ? { _id: { $gt: afterId } } : {};
    const filter = options.all ? after : { $and: [after, staleKeysFilter()] };
    const content = this.model.schema.path('contentText')
      ? ' +contentText +contentTextTruncated'
      : '';
    return this.model
      .find(this.scope(tenantId, filter as QueryFilter<RecordEntity>))
      .select(`+search${content}`)
      .sort({ _id: 1 })
      .limit(limit)
      .lean<BackfillRow[]>()
      .exec();
  }

  async updateDerived(
    tenantId: string,
    filter: QueryFilter<RecordEntity>,
    set: Record<string, unknown>,
  ): Promise<boolean> {
    const paths = Object.keys(set);
    if (paths.length === 0 || paths.some((path) => !path.startsWith(DERIVED_PREFIX))) {
      throw new Error('RecordsRepository: updateDerived writes search.* paths only');
    }
    const update = { $set: set } as UpdateQuery<RecordEntity>;
    this.assertKeepsTenant(update);
    const result = await this.model
      .updateOne(this.scope(tenantId, filter), update, { timestamps: false, runValidators: true })
      .exec();
    return result.modifiedCount === 1;
  }

  async tagCounts(
    tenantId: string,
    visible: QueryFilter<RecordEntity>,
  ): Promise<Array<{ tag: string; count: number }>> {
    return this.model
      .aggregate<{ tag: string; count: number }>([
        { $match: this.scope(tenantId, { $and: [visible, { deletedAt: null }] }) },
        { $unwind: '$tags' },
        { $group: { _id: '$tags', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 200 },
        { $project: { _id: 0, tag: '$_id', count: 1 } },
      ])
      .exec();
  }
}

@Injectable()
export class VersionsRepository extends TenantRepository<RecordVersion> {
  constructor(@InjectModel(RecordVersion.name) model: Model<RecordVersion>) {
    super(model);
  }

  createWithId(
    tenantId: string,
    id: Types.ObjectId,
    data: Omit<NewEntity<RecordVersion>, 'createdAt'>,
  ): Promise<RecordVersionDocument> {
    return this.model.create({ ...data, _id: id, tenantId: toObjectId(tenantId) });
  }

  latest(tenantId: string, recordId: Types.ObjectId): Promise<RecordVersionDocument | null> {
    return this.model
      .findOne(this.scope(tenantId, { recordId }))
      .sort({ versionNumber: -1 })
      .exec();
  }

  byNumber(
    tenantId: string,
    recordId: Types.ObjectId,
    versionNumber: number,
  ): Promise<RecordVersionDocument | null> {
    return this.model.findOne(this.scope(tenantId, { recordId, versionNumber })).exec();
  }
}
