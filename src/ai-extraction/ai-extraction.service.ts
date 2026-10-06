import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Types, type UpdateQuery } from 'mongoose';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { actorOf, type Actor, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { AppError, errors } from '../common/errors.js';
import {
  ContentTypesService,
  isBeingDeleted,
  deletingError,
} from '../content-types/content-types.service.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import type { RecordView } from '../records/record.view.js';
import { RecordsService } from '../records/records.service.js';
import { safeFileName } from '../storage/file-name.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import type { AiExtractionJob, AiExtractionJobDocument } from './ai-extraction-job.schema.js';
import {
  AiExtractionDataService,
  closedUpdate,
  stagingKeyOf,
} from './ai-extraction-data.service.js';
import { ExtractionJobsRepository, statusIn } from './ai-extraction-jobs.repository.js';
import { AiExtractionRunner, sizeBucket } from './ai-extraction.runner.js';
import type { ConfirmExtractionInput, StartExtractionInput } from './ai-extraction.dto.js';
import {
  AiUsageRepository,
  AiUsageService,
  EXTRACTION_USAGE_KIND,
  secondsUntilNextDay,
  usageDayOf,
  type FieldDefinition,
  type Owner,
} from './deps.js';
import { extractionErrors } from './extraction-errors.js';
import { confirmMimeType } from './extraction-mime.js';
import { computeReview, reviewCounts, withoutSnippets } from './extraction-outcomes.js';
import { isFillable } from './extraction-schema.js';
import {
  BUSY_RETRY_AFTER_SECONDS,
  CLAIM_EXTENSION_MS,
  CONFIRM_DEADLINE_MS,
  EXTRACTION_SETTINGS,
  type ExtractionSettings,
} from './extraction-settings.js';
import { toExtractionJobView, type ExtractionJobView } from './extraction-view.js';
import {
  IN_FLIGHT_STATUSES,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  type FieldReview,
} from './extraction.types.js';
import { readHead, sha256OfFile, sniffKind, SNIFF_BYTES } from './file-sniff.js';
import { ExtractionTextSource } from './text-source.js';

export interface ExtractionUpload {
  path: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export function confirmedUpdate(
  recordId: Types.ObjectId,
  review: FieldReview[],
  fields: AiExtractionJob['fields'],
  now: Date,
): UpdateQuery<AiExtractionJob> {
  return {
    $set: {
      status: 'confirmed',
      stage: null,
      recordId,
      review,
      fields: withoutSnippets(fields),
      confirmedAt: now,
      leaseToken: null,
      confirmToken: null,
      confirmClaimedAt: null,
      confirmTarget: null,
    },
  };
}

function isSaving(job: Pick<AiExtractionJob, 'status' | 'confirmToken'>): boolean {
  return job.confirmToken != null && !TERMINAL_STATUSES.includes(job.status);
}

function isClientRefusal(error: unknown): boolean {
  return error instanceof AppError && error.getStatus() < 500;
}

type ConfirmPhase = 'copy' | 'create' | 'created';

const CLEAR_CLAIM: UpdateQuery<AiExtractionJob> = {
  $set: { confirmToken: null, confirmClaimedAt: null, confirmTarget: null },
};

@Injectable()
export class AiExtractionService {
  private readonly logger = new Logger('AiExtraction');
  private readonly liveConfirms = new Set<string>();

  constructor(
    private readonly jobs: ExtractionJobsRepository,
    private readonly data: AiExtractionDataService,
    private readonly runner: AiExtractionRunner,
    private readonly textSource: ExtractionTextSource,
    private readonly contentTypes: ContentTypesService,
    private readonly access: AccessService,
    private readonly policy: PolicyService,
    private readonly records: RecordsService,
    private readonly audit: AuditService,
    private readonly usage: AiUsageService,
    private readonly usageRows: AiUsageRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(EXTRACTION_SETTINGS) private readonly settings: ExtractionSettings,
  ) {}

  async start(
    principal: Principal,
    input: StartExtractionInput,
    upload: ExtractionUpload,
  ): Promise<ExtractionJobView> {
    await this.policy.authorize(principal, 'records.write', { type: 'aiExtraction' });
    const tenantId = principal.tenantId;
    const owner: Owner = { tenantId, userId: principal.userId };
    const type = await this.contentTypes.require(tenantId, input.contentTypeId);
    if (type.status === 'archived') {
      throw errors.conflict(
        'CONTENT_TYPE_ARCHIVED',
        'Archived content types do not accept new records',
      );
    }
    if (isBeingDeleted(type)) throw deletingError();
    if (type.aiExtraction !== true) throw extractionErrors.off();
    if (!type.fields.some((field) => isFillable(field))) throw extractionErrors.noFillableFields();
    await this.access.requireFolder(principal, input.folderId, 'edit');

    const head = await readHead(upload.path, SNIFF_BYTES);
    const kind = sniffKind(head, upload.mimeType, upload.size <= SNIFF_BYTES);
    if (kind === null || !this.textSource.supports(kind)) throw extractionErrors.unsupportedFile();

    const sha256 = await sha256OfFile(upload.path);
    const day = usageDayOf();
    await this.assertTokenCeiling(tenantId, day);
    await this.claimDailyUnit(owner, day);

    const now = new Date();
    const jobId = new Types.ObjectId();
    const stagingKey = stagingKeyOf(tenantId, jobId.toHexString());
    let inserted: AiExtractionJobDocument;
    try {
      inserted = await this.jobs.insert(owner, jobId, {
        status: 'queued',
        stage: null,
        contentTypeId: type._id,
        schemaVersion: type.schemaVersion,
        folderId: toObjectId(input.folderId),
        file: {
          fileName: safeFileName(upload.originalName),
          declaredMimeType: upload.mimeType || 'application/octet-stream',
          kind,
          size: upload.size,
          sha256,
          stagingKey,
        },
        text: { source: null, charsSent: 0, truncated: false },
        fields: null,
        review: null,
        usage: { model: null, inputTokens: null, outputTokens: null, calls: 0, durationMs: null },
        usageDay: day,
        errorCode: null,
        errorReason: null,
        leaseToken: null,
        confirmToken: null,
        confirmClaimedAt: null,
        confirmTarget: null,
        recordId: null,
        expiresAt: new Date(now.getTime() + this.settings.stagingTtlMs),
        finishedAt: null,
        confirmedAt: null,
      });
    } catch (error) {
      await this.giveBack(owner, day);
      throw error;
    }
    await this.assertCapsAfterInsert(owner, jobId, day);
    try {
      await this.storage.putFromPath(stagingKey, upload.path);
    } catch (error) {
      await this.storage.remove(stagingKey).catch(() => undefined);
      await this.jobs.deleteMany(owner, { _id: jobId });
      await this.giveBack(owner, day);
      throw error;
    }
    this.runner.enqueue(owner, jobId.toHexString());
    this.logger.log({
      message: 'Extraction job queued',
      jobId: jobId.toHexString(),
      tenantId,
      kind,
      size: sizeBucket(upload.size),
    });
    return toExtractionJobView(inserted);
  }

  private async assertTokenCeiling(tenantId: string, day: string): Promise<void> {
    const row = await this.usageRows.findOne(tenantId, {
      userId: null,
      kind: EXTRACTION_USAGE_KIND,
      day,
    });
    const spent = (row?.inputTokens ?? 0) + (row?.outputTokens ?? 0);
    if (spent >= this.settings.tenantDailyTokens) {
      throw extractionErrors.tenantLimit(secondsUntilNextDay());
    }
  }

  private async claimDailyUnit(owner: Owner, day: string): Promise<void> {
    const kind = EXTRACTION_USAGE_KIND;
    if (
      !(await this.usage.claim(
        owner.tenantId,
        owner.userId,
        kind,
        this.settings.userDailyLimit,
        day,
      ))
    ) {
      throw extractionErrors.userLimit(secondsUntilNextDay());
    }
    if (
      !(await this.usage.claim(owner.tenantId, null, kind, this.settings.tenantDailyLimit, day))
    ) {
      await this.usage.unclaim(owner.tenantId, owner.userId, kind, day);
      throw extractionErrors.tenantLimit(secondsUntilNextDay());
    }
  }

  private async giveBack(owner: Owner, day: string): Promise<void> {
    await this.usage.unclaim(owner.tenantId, owner.userId, EXTRACTION_USAGE_KIND, day);
    await this.usage.unclaim(owner.tenantId, null, EXTRACTION_USAGE_KIND, day);
  }

  private async assertCapsAfterInsert(
    owner: Owner,
    jobId: Types.ObjectId,
    day: string,
  ): Promise<void> {
    const others = { _id: { $ne: jobId } };
    const [userInFlight, userOpen, tenantInFlight] = await Promise.all([
      this.jobs.count(owner, { ...others, status: statusIn(IN_FLIGHT_STATUSES) }),
      this.jobs.count(owner, { ...others, status: statusIn(OPEN_STATUSES) }),
      this.jobs.countInTenant(owner.tenantId, { ...others, status: statusIn(IN_FLIGHT_STATUSES) }),
    ]);
    const scope =
      userInFlight >= this.settings.userInFlight || userOpen >= this.settings.userOpenJobs
        ? 'user'
        : tenantInFlight >= this.settings.tenantInFlight
          ? 'tenant'
          : null;
    if (!scope) return;
    await this.jobs.deleteMany(owner, { _id: jobId });
    await this.giveBack(owner, day);
    throw extractionErrors.busy(scope, BUSY_RETRY_AFTER_SECONDS);
  }

  async get(principal: Principal, id: string): Promise<ExtractionJobView> {
    return toExtractionJobView(await this.requireOwned(principal, id));
  }

  private async requireOwned(principal: Principal, id: string): Promise<AiExtractionJobDocument> {
    const job = await this.jobs.findById(ownerOfPrincipal(principal), id);
    if (!job) throw errors.notFound('Extraction');
    return job;
  }

  isConfirmLive(token: string): boolean {
    return this.liveConfirms.has(token);
  }

  async confirm(
    principal: Principal,
    id: string,
    input: ConfirmExtractionInput,
  ): Promise<RecordView> {
    const job = await this.requireOwned(principal, id);
    if (job.contentTypeId.toHexString() !== input.contentTypeId)
      throw extractionErrors.typeMismatch();
    if (!isObjectId(input.folderId)) throw errors.notFound('Folder');
    const token = randomUUID();
    const claimed = await this.claim(job, token, input);
    if (!claimed) {
      const current = await this.jobs.findById(ownerOfPrincipal(principal), id);
      if (!current) throw errors.notFound('Extraction');
      throw extractionErrors.notConfirmable(
        current.status,
        current.recordId?.toHexString() ?? null,
        isSaving(current),
      );
    }

    const state: { phase: ConfirmPhase } = { phase: 'copy' };
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new AbortController();
    this.liveConfirms.add(token);
    const work = this.confirmClaimed(principal, claimed, token, input, deadline.signal, (next) => {
      state.phase = next;
    });
    void work.catch(() => undefined).finally(() => this.liveConfirms.delete(token));
    const timedOut = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        deadline.abort();
        reject(extractionErrors.confirmTimeout());
      }, CONFIRM_DEADLINE_MS);
      deadlineTimer.unref();
    });
    try {
      return await Promise.race([work, timedOut]);
    } catch (error) {
      if (state.phase === 'copy') await this.clearClaim(claimed, token);
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      work.catch(() => undefined);
    }
  }

  private async claim(
    job: AiExtractionJobDocument,
    token: string,
    input: ConfirmExtractionInput,
  ): Promise<AiExtractionJobDocument | null> {
    const now = new Date();
    const claim = {
      confirmToken: token,
      confirmClaimedAt: now,
      confirmTarget: { name: input.name, folderId: toObjectId(input.folderId) },
    };
    const extend = { expiresAt: new Date(now.getTime() + CLAIM_EXTENSION_MS) };
    const base = { confirmToken: null, 'file.stagingKey': { $type: 'string' as const } };
    const ready = await this.jobs.updateRow(
      job,
      { ...base, status: statusIn(['ready', 'failed']) },
      { $set: claim, $max: extend },
    );
    if (ready) return ready;
    const failedExtend = {
      expiresAt: new Date(now.getTime() + Math.max(this.settings.stagingTtlMs, CLAIM_EXTENSION_MS)),
    };
    return this.jobs.updateRow(
      job,
      { ...base, status: statusIn(IN_FLIGHT_STATUSES) },
      {
        $set: {
          ...claim,
          status: 'failed',
          stage: null,
          errorCode: 'EXTRACTION_INTERRUPTED',
          errorReason: 'confirm',
          finishedAt: now,
        },
        $max: failedExtend,
      },
    );
  }

  private async clearClaim(claimed: AiExtractionJobDocument, token: string): Promise<void> {
    await this.jobs.updateRow(claimed, { confirmToken: token }, CLEAR_CLAIM).catch(() => {
      this.logger.warn({ message: 'Clearing a confirm claim failed', jobId: claimed.id as string });
    });
  }

  private async confirmClaimed(
    principal: Principal,
    claimed: AiExtractionJobDocument,
    token: string,
    input: ConfirmExtractionInput,
    signal: AbortSignal,
    setPhase: (phase: ConfirmPhase) => void,
  ): Promise<RecordView> {
    const copy = await this.copyStaged(claimed, signal);
    try {
      if (signal.aborted) throw extractionErrors.confirmTimeout();
      setPhase('create');
      let record: RecordView;
      try {
        record = await this.records.create(principal, input, {
          path: copy,
          originalName: claimed.file.fileName ?? 'file',
          mimeType: confirmMimeType(claimed),
        });
      } catch (error) {
        if (isClientRefusal(error)) await this.clearClaim(claimed, token);
        throw error;
      }
      setPhase('created');
      await this.finish(principal, claimed, token, record);
      return record;
    } finally {
      await rm(copy, { force: true });
    }
  }

  private async copyStaged(job: AiExtractionJobDocument, signal: AbortSignal): Promise<string> {
    const tmpDir = join(this.settings.storageDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const copy = join(tmpDir, `ai-confirm-${randomUUID()}`);
    try {
      const source = await this.storage.open(job.file.stagingKey as string);
      await pipeline(source, createWriteStream(copy), { signal });
      await stat(copy);
      return copy;
    } catch (error) {
      await rm(copy, { force: true });
      throw signal.aborted ? extractionErrors.confirmTimeout() : error;
    }
  }

  private async finish(
    principal: Principal,
    claimed: AiExtractionJobDocument,
    token: string,
    record: RecordView,
  ): Promise<void> {
    const ids = { jobId: claimed.id as string, tenantId: principal.tenantId, recordId: record.id };
    let finished: AiExtractionJobDocument | null = null;
    let review: FieldReview[] = [];
    try {
      const typeFields = await this.typeFields(principal.tenantId, claimed.contentTypeId);
      review = computeReview(typeFields, claimed.fields, record.metadata);
      const update = confirmedUpdate(toObjectId(record.id), review, claimed.fields, new Date());
      finished = await this.finishWrite(claimed, token, update);
      if (!finished) {
        this.logger.warn({ message: 'Confirm finish write matched nothing', ...ids });
        return;
      }
    } catch {
      this.logger.error({
        message: 'Confirm finish write failed; the resolver finishes it',
        ...ids,
      });
      return;
    }
    try {
      await this.recordConfirmed(actorOf(principal), principal.tenantId, finished, review, {
        label: record.name,
        recovered: false,
      });
    } catch {
      this.logger.error({ message: 'Writing the confirm audit entry failed', ...ids });
    }
    await this.data.unstage(finished);
  }

  private async finishWrite(
    claimed: AiExtractionJobDocument,
    token: string,
    update: UpdateQuery<AiExtractionJob>,
  ): Promise<AiExtractionJobDocument | null> {
    try {
      return await this.jobs.updateRow(claimed, { confirmToken: token }, update);
    } catch {
      return this.jobs.updateRow(claimed, { confirmToken: token }, update);
    }
  }

  private async typeFields(
    tenantId: string,
    contentTypeId: Types.ObjectId,
  ): Promise<FieldDefinition[]> {
    const type = await this.contentTypes.require(tenantId, contentTypeId.toHexString());
    return type.fields;
  }

  async recordConfirmed(
    actor: Actor | null,
    tenantId: string,
    job: AiExtractionJob & { _id: Types.ObjectId },
    review: FieldReview[],
    { label, recovered }: { label: string; recovered: boolean },
  ): Promise<void> {
    await this.audit.record(tenantId, {
      action: 'AI_EXTRACTION_CONFIRMED',
      actor,
      resource: { type: 'record', id: job.recordId?.toHexString(), label },
      context: {
        jobId: job._id.toHexString(),
        contentTypeId: job.contentTypeId.toHexString(),
        textSource: job.text?.source ?? null,
        truncated: job.text?.truncated === true,
        model: job.usage?.model ?? null,
        inputTokens: job.usage?.inputTokens ?? null,
        outputTokens: job.usage?.outputTokens ?? null,
        counts: reviewCounts(review, job.fields),
        ...(recovered ? { recovered: true } : {}),
      },
    });
  }

  async discard(principal: Principal, id: string): Promise<void> {
    const job = await this.requireOwned(principal, id);
    if (TERMINAL_STATUSES.includes(job.status)) return;
    if (job.confirmToken) throw extractionErrors.notConfirmable(job.status, null, true);
    const closed = await this.jobs.updateRow(
      job,
      { status: statusIn(OPEN_STATUSES), confirmToken: null },
      closedUpdate('discarded', new Date()),
    );
    if (!closed) {
      const now = await this.requireOwned(principal, id);
      if (TERMINAL_STATUSES.includes(now.status)) return;
      throw extractionErrors.notConfirmable(
        now.status,
        now.recordId?.toHexString() ?? null,
        isSaving(now),
      );
    }
    await this.data.unstage(closed);
  }
}

function ownerOfPrincipal(principal: Principal): Owner {
  return { tenantId: principal.tenantId, userId: principal.userId };
}
