import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { ContentTypesRepository } from '../content-types/content-types.repository.js';
import { toObjectId } from '../database/object-id.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import type { AiExtractionJob } from './ai-extraction-job.schema.js';
import { ExtractionJobsRepository } from './ai-extraction-jobs.repository.js';
import {
  AiProvider,
  AiUsageService,
  EXTRACTION_USAGE_KIND,
  redactProviderError,
  type Owner,
} from './deps.js';
import { callExtractionModel, type ModelOutcome } from './extraction-model.js';
import { buildExtractionMessages } from './extraction-prompt.js';
import { planExtraction } from './extraction-schema.js';
import { EXTRACTION_SETTINGS, type ExtractionSettings } from './extraction-settings.js';
import { validateAnswer } from './extraction-validation.js';
import type {
  ExtractionErrorCode,
  ExtractionErrorReason,
  FieldSuggestion,
  TextSource,
} from './extraction.types.js';
import { cutAtLineBreak, hasVisibleText } from './text-clean.js';
import { ExtractionTextSource, type TextExtraction } from './text-source.js';

const SCAN_THRESHOLD = 20;

interface QueuedJob {
  owner: Owner;
  jobId: string;
}

export function sizeBucket(size: number): string {
  if (size < 64 * 1024) return '<64KB';
  if (size < 1024 * 1024) return '<1MB';
  if (size < 10 * 1024 * 1024) return '<10MB';
  return '>=10MB';
}

class JobFailure {
  constructor(
    readonly code: ExtractionErrorCode,
    readonly reason: ExtractionErrorReason,
  ) {}
}

function textFailure(result: Extract<TextExtraction, { ok: false }>): JobFailure {
  switch (result.reason) {
    case 'unsupported':
      return new JobFailure('UNSUPPORTED_FILE', 'type');
    case 'no_text':
      return new JobFailure('UNSUPPORTED_FILE', 'no_text');
    case 'busy':
    case 'timeout':
      return new JobFailure('EXTRACTION_TIMEOUT', 'text');
  }
}

async function readAtMost(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buffer);
      length += buffer.length;
      if (length >= maxBytes) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

@Injectable()
export class AiExtractionRunner implements OnModuleDestroy {
  private readonly logger = new Logger('AiExtraction');
  private readonly queues = new Map<string, QueuedJob[]>();
  private readonly order: string[] = [];
  private readonly known = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly running = new Set<Promise<void>>();
  private readonly unitsReturned = new Set<string>();
  private active = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly jobs: ExtractionJobsRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly textSource: ExtractionTextSource,
    private readonly provider: AiProvider,
    private readonly usage: AiUsageService,
    private readonly contentTypes: ContentTypesRepository,
    @Inject(EXTRACTION_SETTINGS) private readonly settings: ExtractionSettings,
  ) {}

  enqueue(owner: Owner, jobId: string): void {
    if (this.closed || this.known.has(jobId)) return;
    this.known.add(jobId);
    const queue = this.queues.get(owner.tenantId);
    if (queue) queue.push({ owner, jobId });
    else {
      this.queues.set(owner.tenantId, [{ owner, jobId }]);
      this.order.push(owner.tenantId);
    }
    this.pump();
  }

  isKnown(jobId: string): boolean {
    return this.known.has(jobId);
  }

  idle(): Promise<void> {
    if (this.active === 0 && this.order.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.running);
  }

  private next(): QueuedJob | null {
    const tenantId = this.order.shift();
    if (tenantId === undefined) return null;
    const queue = this.queues.get(tenantId) ?? [];
    const job = queue.shift() ?? null;
    if (queue.length > 0) this.order.push(tenantId);
    else this.queues.delete(tenantId);
    return job;
  }

  private pump(): void {
    while (!this.closed && this.active < this.settings.concurrency) {
      const job = this.next();
      if (!job) break;
      this.active += 1;
      const run = this.processJob(job.owner, job.jobId).finally(() => {
        this.active -= 1;
        this.known.delete(job.jobId);
        this.running.delete(run);
        this.pump();
        if (this.active === 0 && this.order.length === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const resolve of waiters) resolve();
        }
      });
      this.running.add(run);
    }
  }

  async processJob(owner: Owner, jobId: string): Promise<void> {
    const ids = { jobId, tenantId: owner.tenantId };
    const lease = randomUUID();
    const started = Date.now();
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    timer.unref();
    let job: AiExtractionJob | null = null;
    const progress = { modelCalled: false };
    try {
      job = await this.jobs.updateOne(
        owner,
        { _id: toObjectId(jobId), status: 'queued', confirmToken: null },
        { $set: { status: 'processing', stage: 'text', leaseToken: lease } },
      );
      if (!job) {
        await this.giveBack(owner, jobId);
        return;
      }
      this.logger.log({ message: 'Extraction job processing', ...ids, stage: 'text' });
      const result = await this.run(owner, jobId, job, lease, controller.signal, () => {
        progress.modelCalled = true;
      });
      const durationMs = Date.now() - started;
      if (result instanceof JobFailure) {
        await this.fail(owner, jobId, lease, result, null, durationMs);
        if (!progress.modelCalled) await this.giveBack(owner, jobId, job.usageDay);
      }
    } catch (error) {
      this.logger.error({
        message: 'Extraction job failed unexpectedly',
        ...ids,
        error: redactProviderError(error),
      });
      if (job) {
        const failure = controller.signal.aborted
          ? new JobFailure('EXTRACTION_TIMEOUT', progress.modelCalled ? 'model' : 'text')
          : new JobFailure('AI_UNAVAILABLE', 'provider');
        await this.fail(owner, jobId, lease, failure, null, Date.now() - started).catch(() => {
          this.logger.warn({ message: 'Recording the extraction failure failed', ...ids });
        });
        if (!progress.modelCalled) {
          await this.giveBack(owner, jobId, job.usageDay).catch(() => undefined);
        }
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      this.unitsReturned.delete(jobId);
    }
  }

  private async run(
    owner: Owner,
    jobId: string,
    job: AiExtractionJob,
    lease: string,
    signal: AbortSignal,
    onModelCall: () => void,
  ): Promise<JobFailure | null> {
    const started = Date.now();
    if (!this.provider.isEnabled()) return new JobFailure('AI_DISABLED', 'not_configured');
    const type = await this.contentTypes.findById(owner.tenantId, job.contentTypeId.toHexString());
    const key = job.file.stagingKey;
    if (!type || !key) return new JobFailure('EXTRACTION_INTERRUPTED', 'restart');

    let bytes: Buffer;
    try {
      const stream = await this.storage.open(key);
      bytes = await readAtMost(stream, this.textSource.maxBytes(job.file.kind));
    } catch {
      return new JobFailure('EXTRACTION_INTERRUPTED', 'restart');
    }
    const extracted = await this.textSource.extract(
      bytes,
      { kind: job.file.kind, mimeType: job.file.declaredMimeType, size: job.file.size },
      signal,
    );
    if (!extracted.ok) return textFailure(extracted);
    if (extracted.source === 'pdf_text' && !hasVisibleText(extracted.text, SCAN_THRESHOLD)) {
      return new JobFailure('UNSUPPORTED_FILE', 'no_text');
    }
    if (signal.aborted) return new JobFailure('EXTRACTION_TIMEOUT', 'text');
    const cut = cutAtLineBreak(extracted.text, this.settings.maxChars);
    const text: { source: TextSource; charsSent: number; truncated: boolean } = {
      source: extracted.source,
      charsSent: cut.text.length,
      truncated: extracted.truncated || cut.truncated,
    };
    const plan = planExtraction(type.fields, this.settings.maxFields);

    const current = await this.jobs.updateOne(
      owner,
      { _id: toObjectId(jobId), status: 'processing', leaseToken: lease, confirmToken: null },
      { $set: { stage: 'fields', text } },
    );
    if (!current) {
      await this.giveBack(owner, jobId, job.usageDay);
      return null;
    }
    if (plan.sent.length === 0) {
      const elapsed = Date.now() - started;
      await this.ready(owner, jobId, lease, plan.skipped, type.schemaVersion, null, elapsed);
      await this.giveBack(owner, jobId, job.usageDay);
      return null;
    }
    let model: ReturnType<AiProvider['model']>;
    try {
      model = this.provider.model('sub');
    } catch {
      return new JobFailure('AI_DISABLED', 'not_configured');
    }
    this.logger.log({
      message: 'Extraction job processing',
      jobId,
      tenantId: owner.tenantId,
      stage: 'fields',
      fieldCount: plan.sent.length,
      charsSent: text.charsSent,
    });
    const messages = buildExtractionMessages(plan.sent, cut.text);
    onModelCall();
    const outcome = await callExtractionModel(
      {
        model,
        system: messages.system,
        user: messages.user,
        schema: plan.schema,
        maxOutputTokens: this.settings.maxOutputTokens,
      },
      signal,
    );
    await this.recordTokens(owner, job.usageDay, outcome);
    if (outcome.calls === 0) await this.giveBack(owner, jobId, job.usageDay);
    const durationMs = Date.now() - started;
    if (!outcome.ok) {
      if (outcome.error) {
        this.logger.warn({
          message: 'The extraction model call failed',
          jobId,
          tenantId: owner.tenantId,
          errorCode: outcome.code,
          errorReason: outcome.reason,
          provider: outcome.error,
        });
      }
      const failure = new JobFailure(outcome.code, outcome.reason);
      await this.fail(owner, jobId, lease, failure, outcome, durationMs);
      return null;
    }
    const fields = validateAnswer(type.fields, plan, outcome.output, cut.text);
    await this.ready(owner, jobId, lease, fields, type.schemaVersion, outcome, durationMs);
    return null;
  }

  private usageOf(outcome: ModelOutcome | null, durationMs: number) {
    return {
      model: outcome?.modelId ?? null,
      inputTokens: outcome ? outcome.usage.inputTokens : null,
      outputTokens: outcome ? outcome.usage.outputTokens : null,
      calls: outcome?.calls ?? 0,
      durationMs,
    };
  }

  private finishFilter(jobId: string, lease: string) {
    return {
      _id: toObjectId(jobId),
      status: 'processing' as const,
      leaseToken: lease,
      confirmToken: null,
    };
  }

  private closing(now: Date) {
    return {
      stage: null,
      leaseToken: null,
      finishedAt: now,
      expiresAt: new Date(now.getTime() + this.settings.stagingTtlMs),
    };
  }

  private async ready(
    owner: Owner,
    jobId: string,
    lease: string,
    fields: FieldSuggestion[],
    schemaVersion: number,
    outcome: ModelOutcome | null,
    durationMs: number,
  ): Promise<void> {
    const written = await this.jobs.updateOne(owner, this.finishFilter(jobId, lease), {
      $set: {
        ...this.closing(new Date()),
        status: 'ready',
        fields,
        schemaVersion,
        usage: this.usageOf(outcome, durationMs),
      },
    });
    this.logger.log({
      message: written
        ? 'Extraction job ready'
        : 'Extraction result dropped: the job was taken meanwhile',
      jobId,
      tenantId: owner.tenantId,
      status: written ? 'ready' : null,
      durationMs,
      inputTokens: outcome?.usage.inputTokens ?? null,
      outputTokens: outcome?.usage.outputTokens ?? null,
      filled: fields.filter((field) => field.status === 'filled').length,
    });
  }

  private async fail(
    owner: Owner,
    jobId: string,
    lease: string,
    failure: JobFailure,
    outcome: ModelOutcome | null,
    durationMs: number,
  ): Promise<void> {
    const written = await this.jobs.updateOne(owner, this.finishFilter(jobId, lease), {
      $set: {
        ...this.closing(new Date()),
        status: 'failed',
        errorCode: failure.code,
        errorReason: failure.reason,
        usage: this.usageOf(outcome, durationMs),
      },
    });
    this.logger.log({
      message: written
        ? 'Extraction job failed'
        : 'Extraction failure dropped: the job was taken meanwhile',
      jobId,
      tenantId: owner.tenantId,
      status: written ? 'failed' : null,
      errorCode: failure.code,
      errorReason: failure.reason,
      durationMs,
    });
  }

  private async recordTokens(owner: Owner, day: string, outcome: ModelOutcome): Promise<void> {
    const { inputTokens, outputTokens } = outcome.usage;
    if (inputTokens === null || outputTokens === null || outcome.calls === 0) return;
    const tokens = { inputTokens, outputTokens };
    const kind = EXTRACTION_USAGE_KIND;
    try {
      await this.usage.recordTokens(owner.tenantId, owner.userId, kind, tokens, day);
      await this.usage.recordTokens(owner.tenantId, null, kind, tokens, day);
    } catch {
      this.logger.warn({ message: 'Recording extraction tokens failed', tenantId: owner.tenantId });
    }
  }

  private async giveBack(owner: Owner, jobId: string, day?: string): Promise<void> {
    if (this.unitsReturned.has(jobId)) return;
    this.unitsReturned.add(jobId);
    const usageDay = day ?? (await this.jobs.findById(owner, jobId))?.usageDay;
    if (!usageDay) return;
    await this.usage.unclaim(owner.tenantId, owner.userId, EXTRACTION_USAGE_KIND, usageDay);
    await this.usage.unclaim(owner.tenantId, null, EXTRACTION_USAGE_KIND, usageDay);
  }
}
