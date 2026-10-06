import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Types } from 'mongoose';
import { isDuplicateKey } from '../common/duplicate-key.js';
import { ContentTypesRepository } from '../content-types/content-types.repository.js';
import { RecordsRepository, VersionsRepository } from '../records/records.repository.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import { UsersRepository } from '../users/users.repository.js';
import { AiExtractionDataService, closedUpdate } from './ai-extraction-data.service.js';
import {
  ExtractionJobsRepository,
  ownerOf,
  statusIn,
  type HousekeepingQuery,
  type JobRow,
} from './ai-extraction-jobs.repository.js';
import { AiExtractionRunner } from './ai-extraction.runner.js';
import { AiExtractionService, confirmedUpdate } from './ai-extraction.service.js';
import { AiUsageService, EXTRACTION_USAGE_KIND } from './deps.js';
import { computeReview } from './extraction-outcomes.js';
import { ExtractionBlobsReader } from './extraction-readers.js';
import {
  EXTRACTION_SETTINGS,
  HOUSEKEEPING_BATCH,
  PROCESSING_GRACE_MS,
  QUEUED_STUCK_MS,
  type ExtractionSettings,
} from './extraction-settings.js';
import { OPEN_STATUSES } from './extraction.types.js';

export interface HousekeepOptions {
  bootstrap?: boolean;
  now?: Date;
}

export interface HousekeepResult {
  interrupted: number;
  missingFiles: number;
  resolved: number;
  claimsCleared: number;
  expired: number;
  unstaged: number;
  stuck: number;
}

class Budget {
  constructor(private left: number) {}
  take(): number {
    return this.left;
  }
  spend(count: number): void {
    this.left = Math.max(0, this.left - count);
  }
  get exhausted(): boolean {
    return this.left <= 0;
  }
}

@Injectable()
export class AiExtractionHousekeeping implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('AiExtraction');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<HousekeepResult> | null = null;

  constructor(
    private readonly jobs: ExtractionJobsRepository,
    private readonly data: AiExtractionDataService,
    private readonly runner: AiExtractionRunner,
    private readonly extractions: AiExtractionService,
    private readonly blobs: ExtractionBlobsReader,
    private readonly versions: VersionsRepository,
    private readonly records: RecordsRepository,
    private readonly contentTypes: ContentTypesRepository,
    private readonly users: UsersRepository,
    private readonly usage: AiUsageService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(EXTRACTION_SETTINGS) private readonly settings: ExtractionSettings,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.housekeep({ bootstrap: true });
    if (this.settings.sweepIntervalMs > 0) {
      this.timer = setInterval(() => void this.housekeep(), this.settings.sweepIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async housekeep(options: HousekeepOptions = {}): Promise<HousekeepResult> {
    while (this.running) await this.running.catch(() => undefined);
    this.running = this.pass(options);
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async pass(options: HousekeepOptions): Promise<HousekeepResult> {
    const now = options.now ?? new Date();
    const result: HousekeepResult = {
      interrupted: 0,
      missingFiles: 0,
      resolved: 0,
      claimsCleared: 0,
      expired: 0,
      unstaged: 0,
      stuck: 0,
    };
    const budget = new Budget(options.bootstrap ? Number.POSITIVE_INFINITY : HOUSEKEEPING_BATCH);
    const step = async (name: string, run: () => Promise<void>) => {
      if (budget.exhausted) return;
      try {
        await run();
      } catch (error) {
        this.logger.warn({
          message: 'Extraction housekeeping step failed',
          step: name,
          error: error instanceof Error ? error.name : 'Unknown',
        });
      }
    };
    if (options.bootstrap) {
      await step('interrupted', async () => {
        result.interrupted = await this.each({ pass: 'interrupted' }, budget, (row) =>
          this.failInterrupted(row, now),
        );
      });
      await step('missingFiles', async () => {
        result.missingFiles = await this.each({ pass: 'staged' }, budget, (row) =>
          this.failIfFileMissing(row, now),
        );
      });
    }
    await step('claims', async () => {
      const claimedBefore = new Date(now.getTime() - this.settings.confirmStaleMs);
      await this.each({ pass: 'staleClaims', claimedBefore }, budget, async (row) => {
        const outcome = await this.resolveClaim(row, now);
        if (outcome === 'resolved') result.resolved += 1;
        if (outcome === 'cleared') result.claimsCleared += 1;
        return outcome !== null;
      });
    });
    await step('expired', async () => {
      result.expired = await this.each({ pass: 'expired', now }, budget, (row) =>
        this.expire(row, now),
      );
    });
    await step('unstage', async () => {
      result.unstaged = await this.each({ pass: 'unstage' }, budget, async (row) => {
        await this.data.unstage(row);
        return true;
      });
    });
    await step('stuck', async () => {
      const updatedBefore = new Date(
        now.getTime() - (this.settings.timeoutMs + PROCESSING_GRACE_MS),
      );
      const createdBefore = new Date(now.getTime() - QUEUED_STUCK_MS);
      result.stuck += await this.each({ pass: 'stuckProcessing', updatedBefore }, budget, (row) =>
        this.failStuck(row, now),
      );
      result.stuck += await this.each({ pass: 'stuckQueued', createdBefore }, budget, (row) =>
        this.runner.isKnown(row._id.toHexString())
          ? Promise.resolve(false)
          : this.failStuck(row, now),
      );
    });
    const touched = Object.values(result).some((count) => count > 0);
    if (touched) this.logger.log({ message: 'Extraction housekeeping', ...result });
    return result;
  }

  private async each(
    query: HousekeepingQuery,
    budget: Budget,
    handle: (row: JobRow) => Promise<boolean>,
  ): Promise<number> {
    let handled = 0;
    let after: Types.ObjectId | null = null;
    while (!budget.exhausted) {
      const limit = Math.min(HOUSEKEEPING_BATCH, budget.take());
      const rows = await this.jobs.housekeepingBatch(query, limit, after);
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          if (await handle(row)) handled += 1;
        } catch (error) {
          this.logger.warn({
            message: 'Extraction housekeeping skipped a row',
            jobId: row._id.toHexString(),
            tenantId: row.tenantId.toHexString(),
            error: error instanceof Error ? error.name : 'Unknown',
          });
        }
      }
      budget.spend(rows.length);
      after = rows[rows.length - 1]?._id ?? null;
      if (rows.length < limit) break;
    }
    return handled;
  }

  private interruptedUpdate(now: Date) {
    return {
      $set: {
        status: 'failed',
        stage: null,
        errorCode: 'EXTRACTION_INTERRUPTED',
        errorReason: 'restart',
        leaseToken: null,
        finishedAt: now,
        expiresAt: new Date(now.getTime() + this.settings.stagingTtlMs),
      },
    } as const;
  }

  private async failInterrupted(row: JobRow, now: Date): Promise<boolean> {
    const failed = await this.jobs.updateRow(
      row,
      { status: row.status, leaseToken: row.leaseToken, confirmToken: null },
      this.interruptedUpdate(now),
    );
    if (!failed) return false;
    await this.giveBackIfQueued(row);
    return true;
  }

  private async giveBackIfQueued(row: JobRow): Promise<void> {
    if (row.status !== 'queued') return;
    const { tenantId, userId } = ownerOf(row);
    try {
      await this.usage.unclaim(tenantId, userId, EXTRACTION_USAGE_KIND, row.usageDay);
      await this.usage.unclaim(tenantId, null, EXTRACTION_USAGE_KIND, row.usageDay);
    } catch {
      this.logger.warn({
        message: 'Giving back an extraction unit failed',
        jobId: row._id.toHexString(),
        tenantId,
      });
    }
  }

  private async failIfFileMissing(row: JobRow, now: Date): Promise<boolean> {
    const key = row.file.stagingKey;
    if (!key || (await this.storage.exists(key))) return false;
    const update = this.interruptedUpdate(now);
    const failed = await this.jobs.updateRow(
      row,
      { status: statusIn(OPEN_STATUSES), confirmToken: null, 'file.stagingKey': key },
      { $set: { ...update.$set, 'file.stagingKey': null } },
    );
    return failed !== null;
  }

  private async expire(row: JobRow, now: Date): Promise<boolean> {
    const expired = await this.jobs.updateRow(
      row,
      { status: row.status, confirmToken: null, expiresAt: { $lt: now } },
      closedUpdate('expired', now),
    );
    if (!expired) return false;
    await this.data.unstage(expired);
    return true;
  }

  private async failStuck(row: JobRow, now: Date): Promise<boolean> {
    const failed = await this.jobs.updateRow(
      row,
      { status: row.status, leaseToken: row.leaseToken, confirmToken: null },
      this.interruptedUpdate(now),
    );
    if (!failed) return false;
    await this.giveBackIfQueued(row);
    await this.data.unstage(failed);
    return true;
  }

  private async resolveClaim(row: JobRow, now: Date): Promise<'resolved' | 'cleared' | null> {
    const token = row.confirmToken;
    if (!token || !row.confirmClaimedAt) return null;
    if (this.extractions.isConfirmLive(token)) return null;
    const tenantId = row.tenantId.toHexString();
    for (const record of await this.candidateRecords(row)) {
      if (await this.jobs.isRecordBound(tenantId, record._id)) continue;
      const type = await this.contentTypes.findById(tenantId, row.contentTypeId.toHexString());
      const review = computeReview(type?.fields ?? [], row.fields, record.metadata);
      let finished: JobRow | null;
      try {
        const updated = await this.jobs.updateRow(
          row,
          { confirmToken: token },
          confirmedUpdate(record._id, review, row.fields, now),
        );
        finished = updated ? (updated.toObject() as JobRow) : null;
      } catch (error) {
        if (isDuplicateKey(error)) continue;
        throw error;
      }
      if (!finished) return null;
      const user = await this.users.findById(tenantId, row.userId.toHexString());
      const actor = user
        ? { id: user.id as string, email: user.email, displayName: user.displayName }
        : null;
      await this.extractions.recordConfirmed(actor, tenantId, finished, review, {
        label: record.name,
        recovered: true,
      });
      await this.data.unstage(finished);
      return 'resolved';
    }
    const cleared = await this.jobs.updateRow(
      row,
      { confirmToken: token },
      { $set: { confirmToken: null, confirmClaimedAt: null, confirmTarget: null } },
    );
    return cleared ? 'cleared' : null;
  }

  private async candidateRecords(row: JobRow) {
    const tenantId = row.tenantId.toHexString();
    const sha256 = row.file.sha256;
    const target = row.confirmTarget;
    if (!sha256 || !target || !row.confirmClaimedAt) return [];
    const blob = await this.blobs.findOne(tenantId, { sha256 });
    if (!blob) return [];
    const versions = await this.versions.find(tenantId, {
      versionNumber: 1,
      'file.blobId': blob._id,
      createdBy: row.userId,
      createdAt: { $gte: row.confirmClaimedAt },
    });
    if (versions.length === 0) return [];
    return this.records.find(
      tenantId,
      {
        _id: { $in: versions.map((version) => version.recordId) },
        contentTypeId: row.contentTypeId,
        name: target.name,
        folderId: target.folderId,
      },
      { sort: { createdAt: 1 } },
    );
  }
}
