import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  answer,
  rawText,
  ScriptedExtractionProvider,
  throws,
  type GenerateStep,
} from '../../test/helpers/scripted-extraction-ai.js';
import type { ContentTypesRepository } from '../content-types/content-types.repository.js';
import type { FileStorage } from '../storage/file-storage.js';
import type { ExtractionJobsRepository } from './ai-extraction-jobs.repository.js';
import { AiExtractionRunner, sizeBucket } from './ai-extraction.runner.js';
import type { AiUsageService, FieldDefinition } from './deps.js';
import type { ExtractionSettings } from './extraction-settings.js';
import { PlainTextSource } from './text-source.js';

const SENTINEL = 'SENTINEL-7f3a-do-not-log';

const FIELDS: FieldDefinition[] = [
  { key: 'supplier', label: `Supplier ${SENTINEL}`, type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: false },
];

const DOCUMENT = `Supplier: ${SENTINEL} Trading\nAmount: 42\n`;

const SETTINGS = {
  maxChars: 30000,
  maxFields: 24,
  maxOutputTokens: 4000,
  timeoutMs: 2000,
  concurrency: 1,
  stagingTtlMs: 60_000,
} as ExtractionSettings;

function fakeJobs(job: Record<string, unknown>) {
  const matches = (filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, expected]) => {
      if (key === '_id') return String(expected) === String(job['_id']);
      if (expected && typeof expected === 'object' && '$in' in expected) {
        return (expected.$in as unknown[]).includes(job[key]);
      }
      return job[key] === expected;
    });
  return {
    updateOne: (
      _owner: unknown,
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown> },
    ) => {
      if (!matches(filter)) return Promise.resolve(null);
      Object.assign(job, update.$set ?? {});
      return Promise.resolve({ ...job });
    },
    findById: () => Promise.resolve({ ...job }),
  } as unknown as ExtractionJobsRepository;
}

function runnerFor(
  steps: GenerateStep[],
  overrides: { usage?: AiUsageService; contentTypes?: ContentTypesRepository } = {},
) {
  const id = new Types.ObjectId();
  const job: Record<string, unknown> = {
    _id: id,
    status: 'queued',
    stage: null,
    leaseToken: null,
    confirmToken: null,
    contentTypeId: new Types.ObjectId(),
    usageDay: '2026-10-01',
    file: {
      fileName: `${SENTINEL}.txt`,
      declaredMimeType: 'text/plain',
      kind: 'text',
      size: Buffer.byteLength(DOCUMENT),
      sha256: 'x',
      stagingKey: 'ai-staging/t/j',
    },
  };
  const storage = {
    open: () => Promise.resolve(Readable.from([Buffer.from(DOCUMENT)])),
  } as unknown as FileStorage;
  const usage =
    overrides.usage ??
    ({
      recordTokens: () => Promise.resolve(),
      unclaim: () => Promise.resolve(),
    } as unknown as AiUsageService);
  const contentTypes =
    overrides.contentTypes ??
    ({
      findById: () => Promise.resolve({ fields: FIELDS, schemaVersion: 1 }),
    } as unknown as ContentTypesRepository);
  const provider = new ScriptedExtractionProvider().script(...steps);
  const runner = new AiExtractionRunner(
    fakeJobs(job),
    storage,
    new PlainTextSource(),
    provider,
    usage,
    contentTypes,
    SETTINGS,
  );
  const owner = {
    tenantId: new Types.ObjectId().toHexString(),
    userId: new Types.ObjectId().toHexString(),
  };
  return { runner, job, owner, id: id.toHexString(), provider };
}

function captureLogs() {
  const spies = [
    ...(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    ),
    ...(['log', 'warn', 'error', 'info', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    ),
  ];
  return {
    text: () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls)),
    count: () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

describe('AiExtractionRunner logging', () => {
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it('never logs the document, values, snippets, labels or file name on the success path', async () => {
    const { runner, job, owner, id, provider } = runnerFor([
      answer({
        supplier: {
          value: `${SENTINEL} Trading`,
          confidence: 0.9,
          sourceSnippet: `Supplier: ${SENTINEL} Trading`,
        },
        amount: { value: '42', confidence: 0.9, sourceSnippet: 'Amount: 42' },
      }),
    ]);
    await runner.processJob(owner, id);
    expect(job['status']).toBe('ready');
    expect(provider.promptsText()).toContain(SENTINEL);
    expect(JSON.stringify(job['fields'])).toContain(SENTINEL);
    expect(logs.count()).toBeGreaterThan(0);
    expect(logs.text()).not.toContain(SENTINEL);
  });

  it('never logs model output on the schema-parse failure path', async () => {
    const { runner, job, owner, id } = runnerFor([
      rawText(`{"supplier": "${SENTINEL}"}`),
      rawText(`not json ${SENTINEL}`),
    ]);
    await runner.processJob(owner, id);
    expect(job).toMatchObject({
      status: 'failed',
      errorCode: 'AI_UNAVAILABLE',
      errorReason: 'bad_output',
    });
    expect(logs.text()).not.toContain(SENTINEL);
  });

  it('never logs the message of a thrown non-provider error', async () => {
    const { runner, job, owner, id } = runnerFor([throws(new TypeError(`boom ${SENTINEL}`))]);
    await runner.processJob(owner, id);
    expect(job).toMatchObject({
      status: 'failed',
      errorCode: 'AI_UNAVAILABLE',
      errorReason: 'provider',
    });
    expect(logs.text()).not.toContain(SENTINEL);
  });

  it('drops its result when a confirm claimed the job meanwhile', async () => {
    const { runner, job, owner, id, provider } = runnerFor([]);
    provider.script(async () => {
      Object.assign(job, { confirmToken: 'claimed', status: 'failed', errorReason: 'confirm' });
      const step = answer({
        supplier: { value: 'Late', confidence: 0.9, sourceSnippet: 'Supplier:' },
        amount: { value: null, confidence: 0, sourceSnippet: null },
      });
      return typeof step === 'function' ? step({} as never) : step;
    });
    await runner.processJob(owner, id);
    expect(job).toMatchObject({ status: 'failed', errorReason: 'confirm' });
    expect(job['fields']).toBeUndefined();
  });

  it('buckets sizes instead of logging them', () => {
    expect([
      sizeBucket(10),
      sizeBucket(100_000),
      sizeBucket(5_000_000),
      sizeBucket(50_000_000),
    ]).toEqual(['<64KB', '<1MB', '<10MB', '>=10MB']);
  });
});

describe('AiExtractionRunner daily unit give-back', () => {
  it('gives a unit back at most once per job, even when the first give-back failed half-way', async () => {
    const logs = captureLogs();
    const unclaim = vi.fn((_tenantId: string, userId: string | null) =>
      userId === null && unclaim.mock.calls.length === 2
        ? Promise.reject(new Error('Write failed'))
        : Promise.resolve(),
    );
    const usage = { recordTokens: () => Promise.resolve(), unclaim } as unknown as AiUsageService;
    const contentTypes = {
      findById: () => Promise.resolve(null),
    } as unknown as ContentTypesRepository;
    const { runner, job, owner, id } = runnerFor([], { usage, contentTypes });
    await runner.processJob(owner, id);
    logs.restore();
    expect(job).toMatchObject({ status: 'failed', errorCode: 'EXTRACTION_INTERRUPTED' });
    const userGiveBacks = unclaim.mock.calls.filter(([, userId]) => userId === owner.userId);
    expect(userGiveBacks).toHaveLength(1);
  });
});
