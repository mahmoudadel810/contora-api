import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import type { Test } from 'supertest';
import { ExtractionJobsRepository } from '../../src/ai-extraction/ai-extraction-jobs.repository.js';
import { AiExtractionHousekeeping } from '../../src/ai-extraction/ai-extraction.housekeeping.js';
import { AiExtractionRunner } from '../../src/ai-extraction/ai-extraction.runner.js';
import { AiExtractionService } from '../../src/ai-extraction/ai-extraction.service.js';
import { AiProvider } from '../../src/ai-extraction/deps.js';
import {
  EXTRACTION_SETTINGS,
  type ExtractionSettings,
} from '../../src/ai-extraction/extraction-settings.js';
import type { ExtractionJobView } from '../../src/ai-extraction/extraction-view.js';
import { FILE_STORAGE, type FileStorage } from '../../src/storage/file-storage.js';
import { as, type Actor } from './actors.js';
import { answer, ScriptedExtractionProvider, type AnswerField } from './scripted-extraction-ai.js';
import { createTestApp, type TestApp } from './test-app.js';

export const EXTRACTION_TEST_ENV: Record<string, string> = {
  AI_EXTRACTION_SWEEP_MINUTES: '0',
  AI_EXTRACTION_TIMEOUT_MS: '5000',
  AI_EXTRACTION_USER_DAILY_LIMIT: '1000',
  AI_EXTRACTION_TENANT_DAILY_LIMIT: '10000',
  AI_EXTRACTION_USER_OPEN_JOBS: '50',
  AI_EXTRACTION_USER_IN_FLIGHT: '1',
  AI_EXTRACTION_TENANT_IN_FLIGHT: '50',
};

export interface ExtractionApp {
  ctx: TestApp;
  ai: ScriptedExtractionProvider;
  db: Connection;
  jobs: ExtractionJobsRepository;
  runner: AiExtractionRunner;
  housekeeping: AiExtractionHousekeeping;
  service: AiExtractionService;
  storage: FileStorage;
  settings: ExtractionSettings;
}

export async function createExtractionApp(
  env: Record<string, string> = {},
): Promise<ExtractionApp> {
  const ai = new ScriptedExtractionProvider();
  const ctx = await createTestApp(
    [],
    { ...EXTRACTION_TEST_ENV, ...env },
    { configure: (builder) => builder.overrideProvider(AiProvider).useValue(ai) },
  );
  return {
    ctx,
    ai,
    db: ctx.app.get<Connection>(getConnectionToken()),
    jobs: ctx.app.get(ExtractionJobsRepository),
    runner: ctx.app.get(AiExtractionRunner),
    housekeeping: ctx.app.get(AiExtractionHousekeeping),
    service: ctx.app.get(AiExtractionService),
    storage: ctx.app.get<FileStorage>(FILE_STORAGE),
    settings: ctx.app.get<ExtractionSettings>(EXTRACTION_SETTINGS),
  };
}

export const EXTRACTION_TYPE = {
  name: 'AI invoice',
  description: 'Invoices filled by automatic extraction',
  aiExtraction: true,
  fields: [
    { key: 'supplier', label: 'Supplier', type: 'text', required: true },
    { key: 'invoiceNumber', label: 'Invoice number', type: 'text', required: false, maxLength: 40 },
    { key: 'amount', label: 'Amount', type: 'number', required: true, min: 0 },
    { key: 'dueDate', label: 'Due date', type: 'date', required: false },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      required: false,
      options: ['Open', 'Paid'],
    },
    { key: 'owner', label: 'Owner', type: 'user', required: false },
  ],
};

export const SENT_KEYS = ['supplier', 'invoiceNumber', 'amount', 'dueDate', 'status'];

export const INVOICE_TEXT = [
  'INVOICE',
  'Supplier: Acme Corp',
  'Invoice number: INV-2026-042',
  'Amount: 1250.50',
  'Due date: 2026-03-15',
  'Status: Open',
  '',
].join('\n');

export function invoiceAnswer(overrides: Record<string, AnswerField> = {}) {
  return answer({
    supplier: { value: 'Acme Corp', confidence: 0.95, sourceSnippet: 'Supplier: Acme Corp' },
    invoiceNumber: {
      value: 'INV-2026-042',
      confidence: 0.9,
      sourceSnippet: 'Invoice number: INV-2026-042',
    },
    amount: { value: '1250.50', confidence: 0.92, sourceSnippet: 'Amount: 1250.50' },
    dueDate: { value: '2026-03-15', confidence: 0.7, sourceSnippet: 'Due date: 2026-03-15' },
    status: { value: 'Open', confidence: 0.5, sourceSnippet: 'Status: Open' },
    ...overrides,
  });
}

export interface ExtractionWorkspace {
  rootId: string;
  folderId: string;
  typeId: string;
  typeName: string;
}

let typeCounter = 0;

export async function extractionWorkspace(
  ctx: TestApp,
  admin: Actor,
  type: Record<string, unknown> = EXTRACTION_TYPE,
): Promise<ExtractionWorkspace> {
  typeCounter += 1;
  const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
  const folder = await as(ctx, admin)
    .post('/api/v1/folders')
    .send({ name: `Inbox ${typeCounter}`, parentId: root.body.folder.id })
    .expect(201);
  const typeName = `${String(type['name'])} ${typeCounter}`;
  const created = await as(ctx, admin)
    .post('/api/v1/content-types')
    .send({ ...type, name: typeName })
    .expect(201);
  return {
    rootId: root.body.folder.id as string,
    folderId: folder.body.id as string,
    typeId: created.body.id as string,
    typeName,
  };
}

export interface UploadFile {
  content: string | Buffer;
  name?: string;
  type?: string;
}

export function startExtraction(
  ctx: TestApp,
  actor: Pick<Actor, 'token'>,
  ws: Pick<ExtractionWorkspace, 'typeId' | 'folderId'>,
  file: UploadFile = { content: INVOICE_TEXT },
): Test {
  return as(ctx, actor)
    .post('/api/v1/ai/extractions')
    .field('contentTypeId', ws.typeId)
    .field('folderId', ws.folderId)
    .attach('file', typeof file.content === 'string' ? Buffer.from(file.content) : file.content, {
      filename: file.name ?? 'invoice.txt',
      contentType: file.type ?? 'text/plain',
    });
}

export async function startJob(
  ctx: TestApp,
  actor: Pick<Actor, 'token'>,
  ws: Pick<ExtractionWorkspace, 'typeId' | 'folderId'>,
  file?: UploadFile,
): Promise<ExtractionJobView> {
  const res = await startExtraction(ctx, actor, ws, file).expect(202);
  return res.body as ExtractionJobView;
}

export async function waitForJob(
  ctx: TestApp,
  actor: Pick<Actor, 'token'>,
  id: string,
  until: (job: ExtractionJobView) => boolean = (job) =>
    job.status !== 'queued' && job.status !== 'processing',
  timeoutMs = 10_000,
): Promise<ExtractionJobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await as(ctx, actor).get(`/api/v1/ai/extractions/${id}`).expect(200);
    const job = res.body as ExtractionJobView;
    if (until(job)) return job;
    if (Date.now() > deadline) throw new Error(`Job ${id} stayed ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function confirmBody(
  ws: Pick<ExtractionWorkspace, 'typeId' | 'folderId'>,
  metadata: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Invoice INV-2026-042',
    contentTypeId: ws.typeId,
    folderId: ws.folderId,
    metadata,
    ...overrides,
  };
}

export function confirm(
  ctx: TestApp,
  actor: Pick<Actor, 'token'>,
  id: string,
  body: Record<string, unknown>,
): Test {
  return as(ctx, actor).post(`/api/v1/ai/extractions/${id}/confirm`).send(body);
}

export async function tmpFiles(app: ExtractionApp): Promise<string[]> {
  try {
    return await readdir(join(app.settings.storageDir, 'tmp'));
  } catch {
    return [];
  }
}

export async function stagedExists(
  app: ExtractionApp,
  tenantId: string,
  jobId: string,
): Promise<boolean> {
  try {
    await stat(join(app.settings.storageDir, 'ai-staging', tenantId, jobId));
    return true;
  } catch {
    return false;
  }
}

export async function jobRow(
  app: ExtractionApp,
  id: string,
): Promise<Record<string, unknown> | null> {
  return app.db.collection('ai_extraction_jobs').findOne({ _id: new Types.ObjectId(id) });
}

export function barrier(count: number, timeoutMs = 3000) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, timeoutMs).unref();
  });
  return {
    async wait(): Promise<void> {
      arrived += 1;
      if (arrived >= count) release();
      await open;
    },
    get arrived() {
      return arrived;
    },
  };
}

export function withoutRequestId(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body };
  delete copy['requestId'];
  return copy;
}
