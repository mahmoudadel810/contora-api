import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type QueryFilter, type Types } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { toObjectId } from '../database/object-id.js';
import { RECORDS_COLLECTION, type RecordEntity } from '../records/record.schema.js';
import { RecordRelation } from './relation.schema.js';
import type { RelationKind } from './relation-kinds.js';

export interface JoinedRelation {
  _id: Types.ObjectId;
  sourceId: Types.ObjectId;
  targetId: Types.ObjectId;
  kind: RelationKind;
  createdBy: Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  other: {
    _id: Types.ObjectId;
    name: string;
    contentTypeId: Types.ObjectId;
    folderId: Types.ObjectId;
  };
}

@Injectable()
export class RelationsRepository extends TenantRepository<RecordRelation> {
  constructor(@InjectModel(RecordRelation.name) model: Model<RecordRelation>) {
    super(model);
  }

  async deleteOne(tenantId: string, filter: QueryFilter<RecordRelation>): Promise<boolean> {
    const result = await this.model.deleteOne(this.scope(tenantId, filter)).exec();
    return result.deletedCount === 1;
  }

  async listFor(
    tenantId: string,
    recordId: Types.ObjectId,
    limit: number,
    visible: QueryFilter<RecordEntity>,
  ): Promise<{ items: JoinedRelation[]; total: number }> {
    const [result] = await this.model
      .aggregate<{ items: JoinedRelation[]; total: { n: number }[] }>([
        { $match: this.scope(tenantId, { $or: [{ sourceId: recordId }, { targetId: recordId }] }) },
        {
          $lookup: {
            from: RECORDS_COLLECTION,
            let: {
              otherId: { $cond: [{ $eq: ['$sourceId', recordId] }, '$targetId', '$sourceId'] },
            },
            pipeline: [
              {
                $match: {
                  $and: [
                    {
                      $expr: { $eq: ['$_id', '$$otherId'] },
                      tenantId: toObjectId(tenantId),
                      deletedAt: null,
                    },
                    visible,
                  ],
                },
              },
              { $project: { name: 1, contentTypeId: 1, folderId: 1 } },
            ],
            as: 'other',
          },
        },
        { $unwind: '$other' },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            items: [{ $limit: limit }],
            total: [{ $count: 'n' }],
          },
        },
      ])
      .exec();
    return { items: result?.items ?? [], total: result?.total[0]?.n ?? 0 };
  }
}
