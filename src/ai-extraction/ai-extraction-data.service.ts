import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Types, UpdateQuery } from 'mongoose';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import type { AiExtractionJob } from './ai-extraction-job.schema.js';
import { ExtractionJobsRepository, statusIn } from './ai-extraction-jobs.repository.js';
import { OPEN_STATUSES } from './extraction.types.js';

type RowRef = Pick<AiExtractionJob, 'tenantId' | 'userId' | 'file'> & { _id: Types.ObjectId };

export function stagingKeyOf(tenantId: string, jobId: string): string {
  return `ai-staging/${tenantId}/${jobId}`;
}

export function closedUpdate(
  status: 'discarded' | 'expired',
  now: Date,
): UpdateQuery<AiExtractionJob> {
  return {
    $set: {
      status,
      stage: null,
      fields: null,
      'file.fileName': null,
      'file.sha256': null,
      leaseToken: null,
      finishedAt: now,
    },
  };
}

@Injectable()
export class AiExtractionDataService {
  private readonly logger = new Logger('AiExtraction');

  constructor(
    private readonly jobs: ExtractionJobsRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async unstage(row: RowRef): Promise<void> {
    const key = row.file.stagingKey;
    if (!key) return;
    try {
      await this.storage.remove(key);
      await this.jobs.updateRow(
        row,
        { 'file.stagingKey': key },
        { $set: { 'file.stagingKey': null } },
      );
    } catch (error) {
      this.logger.warn({
        message: 'Unstaging an extraction file failed; housekeeping retries it',
        jobId: row._id.toHexString(),
        tenantId: row.tenantId.toHexString(),
        error: error instanceof Error ? error.name : 'Unknown',
      });
    }
  }

  async clearForUser(tenantId: string, userId: string): Promise<void> {
    const owner = { tenantId, userId };
    const open = await this.jobs.find(owner, {
      status: statusIn(OPEN_STATUSES),
      confirmToken: null,
    });
    const now = new Date();
    for (const job of open) {
      const closed = await this.jobs.updateRow(
        job,
        { status: statusIn(OPEN_STATUSES), confirmToken: null },
        closedUpdate('discarded', now),
      );
      if (closed) await this.unstage(closed);
    }
  }

  async purgeForRecords(tenantId: string, recordIds: Types.ObjectId[]): Promise<void> {
    if (recordIds.length === 0) return;
    for (const job of await this.jobs.findForRecords(tenantId, recordIds)) {
      if (job.file.stagingKey) await this.storage.remove(job.file.stagingKey);
    }
    await this.jobs.deleteForRecords(tenantId, recordIds);
  }
}
