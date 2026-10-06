import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { HydratedDocument, Model, QueryFilter, Types, UpdateQuery } from 'mongoose';
import { toObjectId } from '../database/object-id.js';
import { TenantRepository, type NewEntity } from '../database/tenant.repository.js';
import { AiExtractionJob } from './ai-extraction-job.schema.js';
import { AiOwnedRepository, type Owner } from './deps.js';
import {
  IN_FLIGHT_STATUSES,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  type ExtractionStatus,
} from './extraction.types.js';

export type JobRow = AiExtractionJob & { _id: Types.ObjectId };

export function ownerOf(row: Pick<AiExtractionJob, 'tenantId' | 'userId'>): Owner {
  return { tenantId: row.tenantId.toHexString(), userId: row.userId.toHexString() };
}

export type HousekeepingQuery =
  | { pass: 'interrupted' }
  | { pass: 'staged' }
  | { pass: 'staleClaims'; claimedBefore: Date }
  | { pass: 'expired'; now: Date }
  | { pass: 'unstage' }
  | { pass: 'stuckProcessing'; updatedBefore: Date }
  | { pass: 'stuckQueued'; createdBefore: Date };

function housekeepingFilter(query: HousekeepingQuery): QueryFilter<AiExtractionJob> {
  switch (query.pass) {
    case 'interrupted':
      return { status: { $in: [...IN_FLIGHT_STATUSES] } };
    case 'staged':
      return { status: { $in: [...OPEN_STATUSES] }, 'file.stagingKey': { $type: 'string' } };
    case 'staleClaims':
      return {
        status: { $in: [...OPEN_STATUSES] },
        confirmClaimedAt: { $type: 'date', $lt: query.claimedBefore },
      };
    case 'expired':
      return {
        status: { $in: ['ready', 'failed'] },
        confirmToken: null,
        expiresAt: { $lt: query.now },
      };
    case 'unstage':
      return { status: { $in: [...TERMINAL_STATUSES] }, 'file.stagingKey': { $type: 'string' } };
    case 'stuckProcessing':
      return { status: 'processing', confirmToken: null, updatedAt: { $lt: query.updatedBefore } };
    case 'stuckQueued':
      return { status: 'queued', confirmToken: null, createdAt: { $lt: query.createdBefore } };
  }
}

@Injectable()
export class ExtractionJobsRepository extends AiOwnedRepository<AiExtractionJob> {
  private readonly tenantRows: TenantRepository<AiExtractionJob>;

  constructor(@InjectModel(AiExtractionJob.name) private readonly jobs: Model<AiExtractionJob>) {
    super(jobs);
    this.tenantRows = new TenantRepository(jobs);
  }

  insert(
    owner: Owner,
    id: Types.ObjectId,
    data: Omit<NewEntity<AiExtractionJob>, 'userId'>,
  ): Promise<HydratedDocument<AiExtractionJob>> {
    return this.jobs.create({
      ...data,
      _id: id,
      tenantId: toObjectId(owner.tenantId),
      userId: toObjectId(owner.userId),
    });
  }

  countInTenant(tenantId: string, filter: QueryFilter<AiExtractionJob>): Promise<number> {
    return this.tenantRows.count(tenantId, filter);
  }

  isRecordBound(tenantId: string, recordId: Types.ObjectId): Promise<boolean> {
    return this.tenantRows.exists(tenantId, { recordId });
  }

  findForRecords(tenantId: string, recordIds: Types.ObjectId[]) {
    return this.tenantRows.find(tenantId, { recordId: { $in: recordIds } });
  }

  deleteForRecords(tenantId: string, recordIds: Types.ObjectId[]): Promise<number> {
    return this.tenantRows.deleteMany(tenantId, { recordId: { $in: recordIds } });
  }

  updateRow(
    row: Pick<AiExtractionJob, 'tenantId' | 'userId'> & { _id: Types.ObjectId },
    filter: QueryFilter<AiExtractionJob>,
    update: UpdateQuery<AiExtractionJob>,
  ): Promise<HydratedDocument<AiExtractionJob> | null> {
    return this.updateOne(ownerOf(row), { ...filter, _id: row._id }, update);
  }

  housekeepingBatch(
    query: HousekeepingQuery,
    limit: number,
    after: Types.ObjectId | null = null,
  ): Promise<JobRow[]> {
    const filter = housekeepingFilter(query);
    return this.jobs
      .find(after ? { $and: [filter, { _id: { $gt: after } }] } : filter)
      .sort({ _id: 1 })
      .limit(limit)
      .lean<JobRow[]>()
      .exec();
  }
}

export function statusIn(statuses: readonly ExtractionStatus[]): { $in: ExtractionStatus[] } {
  return { $in: [...statuses] };
}
