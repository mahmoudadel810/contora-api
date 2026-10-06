import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import {
  confirm,
  confirmBody,
  createExtractionApp,
  EXTRACTION_TYPE,
  extractionWorkspace,
  INVOICE_TEXT,
  invoiceAnswer,
  stagedExists,
  startExtraction,
  startJob,
  tmpFiles,
  waitForJob,
  type ExtractionApp,
  type ExtractionWorkspace,
} from './helpers/ai-extraction.js';
import { hangs, providerError } from './helpers/scripted-extraction-ai.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('AI extraction limits (e2e)', () => {
  describe('upload size', () => {
    let app: ExtractionApp;
    let admin: Actor;
    let ws: ExtractionWorkspace;

    beforeAll(async () => {
      app = await createExtractionApp({ MAX_UPLOAD_MB: '100' });
      admin = await signUp(app.ctx);
      ws = await extractionWorkspace(app.ctx, admin);
    });

    afterAll(async () => {
      await app.ctx.stop();
    });

    it('answers 413 FILE_TOO_LARGE {maxMb: 20} for 21 MB, and no file is left in tmp', async () => {
      const before = await tmpFiles(app);
      const res = await startExtraction(app.ctx, admin, ws, {
        content: Buffer.alloc(21 * 1024 * 1024, 0x61),
        name: 'big.txt',
      });
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ code: 'FILE_TOO_LARGE', details: { maxMb: 20 } });
      expect(await tmpFiles(app)).toEqual(before);
      expect(await app.db.collection('ai_extraction_jobs').countDocuments({})).toBe(0);
    });
  });

  describe('file types, caps and daily limits', () => {
    let app: ExtractionApp;
    let admin: Actor;
    let ws: ExtractionWorkspace;

    beforeAll(async () => {
      app = await createExtractionApp({
        AI_EXTRACTION_USER_OPEN_JOBS: '2',
        AI_EXTRACTION_USER_DAILY_LIMIT: '6',
        AI_EXTRACTION_TIMEOUT_MS: '400',
      });
      admin = await signUp(app.ctx);
      ws = await extractionWorkspace(app.ctx, admin);
    });

    afterAll(async () => {
      await app.ctx.stop();
    });

    const discard = (actor: Actor, id: string) =>
      as(app.ctx, actor).delete(`/api/v1/ai/extractions/${id}`).expect(204);

    it.each([
      ['PNG bytes behind a .pdf name', { content: PNG, name: 'scan.pdf', type: 'application/pdf' }],
      [
        'a PDF (opens with X3)',
        { content: Buffer.from('%PDF-1.7\n'), name: 'a.pdf', type: 'application/pdf' },
      ],
      [
        'a ZIP / DOCX (opens with X3)',
        {
          content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]),
          name: 'a.docx',
          type: 'application/zip',
        },
      ],
      ['text declared as HTML', { content: '<p>Invoice</p>', name: 'a.html', type: 'text/html' }],
      [
        'a NUL byte in text',
        { content: Buffer.from('Invoice\u0000'), name: 'a.txt', type: 'text/plain' },
      ],
    ])(
      'answers 415 UNSUPPORTED_FILE {reason: type} for %s, leaving no file',
      async (_name, file) => {
        const before = await tmpFiles(app);
        const res = await startExtraction(app.ctx, admin, ws, file).expect(415);
        expect(res.body).toMatchObject({ code: 'UNSUPPORTED_FILE', details: { reason: 'type' } });
        expect(await tmpFiles(app)).toEqual(before);
      },
    );

    it('leaves no file in tmp for every other upload refusal', async () => {
      const before = await tmpFiles(app);
      const off = await extractionWorkspace(app.ctx, admin, {
        ...EXTRACTION_TYPE,
        aiExtraction: false,
      });
      await startExtraction(app.ctx, admin, off).expect(409);
      await startExtraction(app.ctx, admin, { ...ws, folderId: '0'.repeat(24) }).expect(404);
      await as(app.ctx, admin)
        .post('/api/v1/ai/extractions')
        .field('contentTypeId', 'bad')
        .field('folderId', ws.folderId)
        .attach('file', Buffer.from(INVOICE_TEXT), 'a.txt')
        .expect(400);
      expect(await tmpFiles(app)).toEqual(before);
    });

    it('answers 429 AI_EXTRACTION_BUSY {scope: user} while a job is in flight', async () => {
      const seen: { signal?: AbortSignal } = {};
      app.ai.script(hangs(seen));
      const first = await startJob(app.ctx, admin, ws);
      const before = await tmpFiles(app);
      const busy = await startExtraction(app.ctx, admin, ws).expect(429);
      expect(busy.body).toMatchObject({ code: 'AI_EXTRACTION_BUSY', details: { scope: 'user' } });
      expect(busy.body.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(await tmpFiles(app)).toEqual(before);
      const failed = await waitForJob(app.ctx, admin, first.id);
      expect(failed).toMatchObject({
        status: 'failed',
        errorCode: 'EXTRACTION_TIMEOUT',
        errorReason: 'model',
        retryable: true,
      });
      expect(seen.signal?.aborted).toBe(true);
      await discard(admin, first.id);
    });

    it('answers 429 {scope: user} at the open-job cap, counting ready and failed jobs', async () => {
      app.ai.script(invoiceAnswer(), invoiceAnswer());
      const one = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, one.id);
      const two = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, two.id);
      const capped = await startExtraction(app.ctx, admin, ws).expect(429);
      expect(capped.body).toMatchObject({ code: 'AI_EXTRACTION_BUSY', details: { scope: 'user' } });
      await discard(admin, one.id);
      await discard(admin, two.id);
    });

    it('retries one scripted 503 and becomes ready', async () => {
      app.ai.script(providerError(503), invoiceAnswer());
      const job = await startJob(app.ctx, admin, ws);
      const ready = await waitForJob(app.ctx, admin, job.id);
      expect(ready.status).toBe('ready');
      expect(app.ai.remaining()).toBe(0);
      await discard(admin, job.id);
    });

    it('a refused confirm leaves tmp unchanged and the staged original intact; a valid one then works', async () => {
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, job.id);
      const before = await tmpFiles(app);
      await confirm(app.ctx, admin, job.id, confirmBody(ws, { supplier: 'Acme' })).expect(400);
      expect(await tmpFiles(app)).toEqual(before);
      expect(await stagedExists(app, admin.tenantId, job.id)).toBe(true);
      await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(ws, { supplier: 'Acme', amount: 2 }),
      ).expect(201);
      expect(await tmpFiles(app)).toEqual(before);
    });

    it('answers 429 AI_EXTRACTION_USER_LIMIT with retryAfterSeconds once the daily jobs are used', async () => {
      app.ai.script(invoiceAnswer());
      const last = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, last.id);
      await discard(admin, last.id);
      const limited = await startExtraction(app.ctx, admin, ws).expect(429);
      expect(limited.body.code).toBe('AI_EXTRACTION_USER_LIMIT');
      expect(limited.body.details.retryAfterSeconds).toBeGreaterThan(0);
      const colleague = await addMember(app.ctx, admin, 'admin');
      app.ai.script(invoiceAnswer());
      await startJob(app.ctx, colleague, ws);
    });
  });

  describe('tenant caps', () => {
    let app: ExtractionApp;
    let admin: Actor;
    let ws: ExtractionWorkspace;

    beforeAll(async () => {
      app = await createExtractionApp({
        AI_EXTRACTION_TENANT_IN_FLIGHT: '1',
        AI_EXTRACTION_TENANT_DAILY_TOKENS: '100',
        AI_EXTRACTION_TIMEOUT_MS: '400',
      });
      admin = await signUp(app.ctx);
      ws = await extractionWorkspace(app.ctx, admin);
    });

    afterAll(async () => {
      await app.ctx.stop();
    });

    it('answers 429 {scope: tenant} when the tenant has its in-flight jobs', async () => {
      app.ai.script(hangs());
      const first = await startJob(app.ctx, admin, ws);
      const colleague = await addMember(app.ctx, admin, 'admin');
      const busy = await startExtraction(app.ctx, colleague, ws).expect(429);
      expect(busy.body).toMatchObject({ code: 'AI_EXTRACTION_BUSY', details: { scope: 'tenant' } });
      await waitForJob(app.ctx, admin, first.id);
    });

    it('answers 429 AI_EXTRACTION_TENANT_LIMIT once the daily token ceiling is spent', async () => {
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, job.id);
      const limited = await startExtraction(app.ctx, admin, ws).expect(429);
      expect(limited.body.code).toBe('AI_EXTRACTION_TENANT_LIMIT');
      expect(limited.body.details.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe('tenant daily job limit', () => {
    let app: ExtractionApp;

    beforeAll(async () => {
      app = await createExtractionApp({ AI_EXTRACTION_TENANT_DAILY_LIMIT: '1' });
    });

    afterAll(async () => {
      await app.ctx.stop();
    });

    it('answers 429 AI_EXTRACTION_TENANT_LIMIT and gives the user unit back', async () => {
      const admin = await signUp(app.ctx);
      const ws = await extractionWorkspace(app.ctx, admin);
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, job.id);
      const colleague = await addMember(app.ctx, admin, 'admin');
      const limited = await startExtraction(app.ctx, colleague, ws).expect(429);
      expect(limited.body.code).toBe('AI_EXTRACTION_TENANT_LIMIT');
      const userRow = await app.db
        .collection('ai_usage_daily')
        .findOne(
          { userId: { $ne: null }, kind: 'extraction', turns: { $gt: 0 } },
          { sort: { _id: -1 } },
        );
      expect(String(userRow?.['userId'])).toBe(admin.userId);
    });
  });
});

describe('AI extraction without an AI configuration (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;

  beforeAll(async () => {
    ctx = await createTestApp([], {
      AI_PROVIDER: '',
      AZURE_OPENAI_RESOURCE_NAME: '',
      AZURE_OPENAI_BASE_URL: '',
      AZURE_OPENAI_API_KEY: '',
      AI_MODEL: '',
    });
    admin = await signUp(ctx);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('answers 503 AI_DISABLED before the upload is stored, and POST /records is unaffected', async () => {
    const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
    const type = await as(ctx, admin)
      .post('/api/v1/content-types')
      .send({ ...EXTRACTION_TYPE, name: 'Disabled AI type' })
      .expect(201);
    const ws = { typeId: type.body.id as string, folderId: root.body.folder.id as string };
    const res = await startExtraction(ctx, admin, ws).expect(503);
    expect(res.body.code).toBe('AI_DISABLED');
    const tmp = await readdir(join(process.env.STORAGE_DIR as string, 'tmp')).catch(() => []);
    expect(tmp).toEqual([]);
    await as(ctx, admin)
      .post('/api/v1/records')
      .field('name', 'Saved without AI')
      .field('contentTypeId', ws.typeId)
      .field('folderId', ws.folderId)
      .field('metadata', JSON.stringify({ supplier: 'Acme', amount: 5 }))
      .attach('file', Buffer.from(INVOICE_TEXT), 'invoice.txt')
      .expect(201);
  });
});
