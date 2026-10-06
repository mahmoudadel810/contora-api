import { Types } from 'mongoose';
import { as, addMember, signUp, type Actor } from './helpers/actors.js';
import {
  confirm,
  confirmBody,
  createExtractionApp,
  EXTRACTION_TYPE,
  extractionWorkspace,
  INVOICE_TEXT,
  invoiceAnswer,
  jobRow,
  SENT_KEYS,
  stagedExists,
  startExtraction,
  startJob,
  waitForJob,
  type ExtractionApp,
  type ExtractionWorkspace,
} from './helpers/ai-extraction.js';
import { after, answer, nullAnswer, providerError } from './helpers/scripted-extraction-ai.js';

describe('AI metadata extraction (e2e)', () => {
  let app: ExtractionApp;
  let admin: Actor;
  let ws: ExtractionWorkspace;

  beforeAll(async () => {
    app = await createExtractionApp();
    admin = await signUp(app.ctx, { tenantName: 'Extraction Co' });
    ws = await extractionWorkspace(app.ctx, admin);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  const count = (collection: string) => app.db.collection(collection).countDocuments({});

  describe('upload → extraction → review → confirm (text kind)', () => {
    it('starts a queued job, becomes ready with validated suggestions, and confirms into a record', async () => {
      app.ai.script(invoiceAnswer());
      const started = await startJob(app.ctx, admin, ws);
      expect(started).toMatchObject({
        status: 'queued',
        stage: null,
        contentTypeId: ws.typeId,
        schemaVersion: 1,
        file: { fileName: 'invoice.txt', kind: 'text', size: Buffer.byteLength(INVOICE_TEXT) },
        text: { source: null, truncated: false },
        fields: null,
        errorCode: null,
        errorReason: null,
        retryable: false,
        recordId: null,
      });
      expect(Object.keys(started).sort()).toEqual(
        [
          'contentTypeId',
          'errorCode',
          'errorReason',
          'expiresAt',
          'fields',
          'file',
          'id',
          'recordId',
          'retryable',
          'schemaVersion',
          'stage',
          'status',
          'text',
        ].sort(),
      );

      const ready = await waitForJob(app.ctx, admin, started.id);
      expect(ready.status).toBe('ready');
      expect(ready.text).toEqual({ source: 'plain', truncated: false });
      const byKey = Object.fromEntries((ready.fields ?? []).map((f) => [f.key, f]));
      expect(byKey['supplier']).toMatchObject({
        status: 'filled',
        value: 'Acme Corp',
        band: 'high',
        sourceSnippet: 'Supplier: Acme Corp',
      });
      expect(byKey['amount']).toMatchObject({ status: 'filled', value: 1250.5, band: 'high' });
      expect(byKey['dueDate']).toMatchObject({ value: '2026-03-15', band: 'medium' });
      expect(byKey['status']).toMatchObject({ value: 'Open', band: 'low' });
      expect(byKey['owner']).toMatchObject({ status: 'skipped', reason: 'USER_FIELD' });

      const sent = app.ai.calls().at(-1);
      const userMessage = JSON.stringify(sent?.prompt);
      expect(userMessage).toContain('\\"document\\":\\"INVOICE\\\\nSupplier: Acme Corp');
      for (const key of SENT_KEYS) expect(userMessage).toContain(`\\"key\\":\\"${key}\\"`);
      expect(userMessage).not.toContain('\\"key\\":\\"owner\\"');

      const created = await confirm(
        app.ctx,
        admin,
        started.id,
        confirmBody(ws, { supplier: 'Acme Corp', amount: 1250.5, dueDate: '2026-03-15' }),
      ).expect(201);
      expect(created.body).toMatchObject({
        name: 'Invoice INV-2026-042',
        contentTypeId: ws.typeId,
        folderId: ws.folderId,
        currentVersion: 1,
        metadata: { supplier: 'Acme Corp', amount: 1250.5, dueDate: '2026-03-15' },
        file: {
          fileName: 'invoice.txt',
          mimeType: 'text/plain',
          size: Buffer.byteLength(INVOICE_TEXT),
        },
      });
      const content = await as(app.ctx, admin)
        .get(`/api/v1/records/${created.body.id}/content`)
        .expect(200);
      expect(content.text).toBe(INVOICE_TEXT);

      const confirmed = await as(app.ctx, admin)
        .get(`/api/v1/ai/extractions/${started.id}`)
        .expect(200);
      expect(confirmed.body).toMatchObject({ status: 'confirmed', recordId: created.body.id });
      expect(await stagedExists(app, admin.tenantId, started.id)).toBe(false);
    });

    it('keeps the existing upload path unchanged: POST /records still works', async () => {
      const res = await as(app.ctx, admin)
        .post('/api/v1/records')
        .field('name', 'Plain upload')
        .field('contentTypeId', ws.typeId)
        .field('folderId', ws.folderId)
        .field('metadata', JSON.stringify({ supplier: 'Plain', amount: 1 }))
        .attach('file', Buffer.from('plain'), 'plain.txt')
        .expect(201);
      expect(res.body.file).toMatchObject({ fileName: 'plain.txt' });
    });
  });

  describe('nothing is persisted as metadata before confirm', () => {
    it('leaves records, versions and blobs untouched until confirm', async () => {
      const unique = `${INVOICE_TEXT}Reference: AT2-${Date.now()}\n`;
      const before = { records: await count('records'), versions: await count('record_versions') };
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, admin, ws, { content: unique });
      await waitForJob(app.ctx, admin, job.id);
      const row = await jobRow(app, job.id);
      const sha256 = (row?.['file'] as { sha256: string } | undefined)?.sha256;
      expect(await count('records')).toBe(before.records);
      expect(await count('record_versions')).toBe(before.versions);
      expect(await app.db.collection('blobs').countDocuments({ sha256 })).toBe(0);

      await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
      ).expect(201);
      expect(await count('records')).toBe(before.records + 1);
      expect(await app.db.collection('blobs').countDocuments({ sha256 })).toBe(1);
    });
  });

  describe('values outside the rules are invalid, with reasons and no raw value', () => {
    it('rejects bad numbers, dates, options and invented snippets', async () => {
      app.ai.script(
        answer({
          supplier: {
            value: 'Globex Ltd',
            confidence: 0.99,
            sourceSnippet: 'Supplier: Globex Ltd',
          },
          invoiceNumber: {
            value: 'INV-2026-042',
            confidence: 0.9,
            sourceSnippet: 'Invoice number: INV-2026-042',
          },
          amount: { value: '1,250.50', confidence: 0.9, sourceSnippet: 'Amount: 1250.50' },
          dueDate: { value: '15/03/2026', confidence: 0.9, sourceSnippet: 'Due date: 2026-03-15' },
          status: { value: 'Overdue', confidence: 0.9, sourceSnippet: 'Status: Open' },
        }),
      );
      const job = await startJob(app.ctx, admin, ws);
      const ready = await waitForJob(app.ctx, admin, job.id);
      const reasons = Object.fromEntries(
        (ready.fields ?? []).map((f) => [f.key, [f.status, f.reason]]),
      );
      expect(reasons).toEqual({
        supplier: ['invalid', 'SNIPPET_NOT_FOUND'],
        invoiceNumber: ['filled', null],
        amount: ['invalid', 'TYPE'],
        dueDate: ['invalid', 'DATE_FORMAT'],
        status: ['invalid', 'NOT_IN_OPTIONS'],
        owner: ['skipped', 'USER_FIELD'],
      });
      const view = JSON.stringify(ready);
      for (const raw of ['Globex', '1,250.50', '15/03/2026', 'Overdue'])
        expect(view).not.toContain(raw);
      const row = JSON.stringify(await jobRow(app, job.id));
      for (const raw of ['Globex', '1,250.50', '15/03/2026', 'Overdue'])
        expect(row).not.toContain(raw);
    });

    it('answers not_found for nulls', async () => {
      app.ai.script(nullAnswer(SENT_KEYS));
      const job = await startJob(app.ctx, admin, ws);
      const ready = await waitForJob(app.ctx, admin, job.id);
      expect(ready.fields?.filter((f) => f.status === 'not_found').map((f) => f.key)).toEqual(
        SENT_KEYS,
      );
    });
  });

  describe('outcomes are computed on the server', () => {
    it('records accepted, edited, cleared and manual outcomes, and audit counts without values', async () => {
      app.ai.script(
        answer({
          supplier: { value: 'Acme Corp', confidence: 0.95, sourceSnippet: 'Supplier: Acme Corp' },
          invoiceNumber: {
            value: 'INV-2026-042',
            confidence: 0.9,
            sourceSnippet: 'Invoice number: INV-2026-042',
          },
          amount: { value: '1250.50', confidence: 0.9, sourceSnippet: 'Amount: 1250.50' },
          dueDate: { value: null, confidence: 0, sourceSnippet: null },
          status: { value: null, confidence: 0, sourceSnippet: null },
        }),
      );
      const job = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, job.id);
      const created = await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(ws, {
          supplier: 'Acme Corp',
          amount: 1300,
          dueDate: '2026-04-01',
        }),
      ).expect(201);

      const row = await jobRow(app, job.id);
      const review = row?.['review'] as Array<{ key: string; outcome: string; final: unknown }>;
      expect(Object.fromEntries(review.map((r) => [r.key, r.outcome]))).toEqual({
        supplier: 'accepted',
        invoiceNumber: 'cleared',
        amount: 'edited',
        dueDate: 'manual',
        status: 'empty',
        owner: 'empty',
      });
      expect(review.find((r) => r.key === 'amount')?.final).toBe(1300);

      const audit = await as(app.ctx, admin).get('/api/v1/audit?pageSize=10').expect(200);
      const entries = audit.body.items as Array<{
        action: string;
        resource: { id?: string };
        context: Record<string, unknown>;
      }>;
      const confirmed = entries.find(
        (e) => e.action === 'AI_EXTRACTION_CONFIRMED' && e.resource.id === created.body.id,
      );
      expect(confirmed?.context).toMatchObject({
        jobId: job.id,
        contentTypeId: ws.typeId,
        textSource: 'plain',
        truncated: false,
        inputTokens: 120,
        outputTokens: 30,
        counts: {
          accepted: 1,
          edited: 1,
          cleared: 1,
          manual: 1,
          empty: 2,
          invalid: 0,
          notFound: 2,
          skipped: 1,
        },
      });
      expect(JSON.stringify(confirmed?.context)).not.toContain('Acme');
      const index = entries.indexOf(confirmed as (typeof entries)[number]);
      expect(entries[index + 1]).toMatchObject({
        action: 'RECORD_CREATED',
        resource: { id: created.body.id },
      });
    });
  });

  describe('the content type toggle', () => {
    it('refuses a type with aiExtraction off, and toggling it does not bump schemaVersion', async () => {
      const off = await extractionWorkspace(app.ctx, admin, {
        ...EXTRACTION_TYPE,
        aiExtraction: false,
      });
      const refused = await startExtraction(app.ctx, admin, off).expect(409);
      expect(refused.body.code).toBe('AI_EXTRACTION_OFF');

      const type = await as(app.ctx, admin).get(`/api/v1/content-types/${off.typeId}`).expect(200);
      expect(type.body).toMatchObject({ aiExtraction: false, schemaVersion: 1 });
      const toggled = await as(app.ctx, admin)
        .patch(`/api/v1/content-types/${off.typeId}`)
        .send({
          name: type.body.name,
          description: type.body.description,
          fields: type.body.fields,
          aiExtraction: true,
        })
        .expect(200);
      expect(toggled.body).toMatchObject({ aiExtraction: true, schemaVersion: 1 });
      const kept = await as(app.ctx, admin)
        .patch(`/api/v1/content-types/${off.typeId}`)
        .send({ name: type.body.name, description: 'Changed', fields: type.body.fields })
        .expect(200);
      expect(kept.body).toMatchObject({ aiExtraction: true, schemaVersion: 1 });

      const audit = await as(app.ctx, admin)
        .get('/api/v1/audit?action=CONTENT_TYPE_UPDATED&pageSize=5')
        .expect(200);
      const contexts = (
        audit.body.items as Array<{ resource: { id: string }; context: Record<string, unknown> }>
      )
        .filter((e) => e.resource.id === off.typeId)
        .map((e) => e.context);
      expect(contexts).toEqual([
        expect.not.objectContaining({ aiExtraction: expect.anything() }),
        expect.objectContaining({ aiExtraction: true, fieldsChanged: false }),
      ]);
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, admin, off);
      await waitForJob(app.ctx, admin, job.id);
    });

    it('defaults to off for a new type', async () => {
      const { aiExtraction: _ignored, ...withoutFlag } = EXTRACTION_TYPE;
      void _ignored;
      const res = await as(app.ctx, admin)
        .post('/api/v1/content-types')
        .send({ ...withoutFlag, name: 'No flag type' })
        .expect(201);
      expect(res.body.aiExtraction).toBe(false);
    });
  });

  describe('graceful failure', () => {
    it('fails AI_UNAVAILABLE after a provider 500 twice, and confirm still creates the record with manual outcomes', async () => {
      app.ai.script(providerError(500), providerError(500));
      const job = await startJob(app.ctx, admin, ws);
      const failed = await waitForJob(app.ctx, admin, job.id);
      expect(failed).toMatchObject({
        status: 'failed',
        errorCode: 'AI_UNAVAILABLE',
        errorReason: 'provider',
        retryable: true,
        fields: null,
      });
      const created = await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(ws, { supplier: 'Typed by hand', amount: 3 }),
      ).expect(201);
      expect(created.body.metadata).toMatchObject({ supplier: 'Typed by hand', amount: 3 });
      const review = (await jobRow(app, job.id))?.['review'] as Array<{
        key: string;
        outcome: string;
        suggestedStatus: string;
      }>;
      expect(review.filter((r) => r.outcome === 'manual').map((r) => r.key)).toEqual([
        'supplier',
        'amount',
      ]);
      expect(review.every((r) => r.suggestedStatus === 'none')).toBe(true);
    });
  });

  describe('confirm details', () => {
    it('stores a text file under its MIME type without parameters', async () => {
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, admin, ws, {
        content: INVOICE_TEXT,
        type: 'text/plain; charset=utf-8',
      });
      await waitForJob(app.ctx, admin, job.id);
      const created = await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
      ).expect(201);
      expect(created.body.file).toMatchObject({ mimeType: 'text/plain' });
    });

    it('confirming a running job resets its expiry to now + TTL, as any failed job', async () => {
      let jobId = '';
      let refused = 0;
      app.ai.script(
        after(async () => {
          while (jobId === '') await new Promise((resolve) => setTimeout(resolve, 5));
          await app.db
            .collection('ai_extraction_jobs')
            .updateOne(
              { _id: new Types.ObjectId(jobId) },
              { $set: { expiresAt: new Date(Date.now() - 60_000) } },
            );
          refused = (await confirm(app.ctx, admin, jobId, confirmBody(ws, { amount: 'lots' })))
            .status;
        }, invoiceAnswer()),
      );
      jobId = (await startJob(app.ctx, admin, ws)).id;
      await waitForJob(app.ctx, admin, jobId, (job) => job.status === 'failed');
      await app.runner.idle();
      expect(refused).toBe(400);
      const row = await jobRow(app, jobId);
      expect(row).toMatchObject({ status: 'failed', errorReason: 'confirm', confirmToken: null });
      const expiresAt = (row?.['expiresAt'] as Date | undefined)?.getTime() ?? 0;
      expect(expiresAt).toBeGreaterThan(Date.now() + app.settings.stagingTtlMs - 60_000);
    });
  });

  describe('validation and refusals', () => {
    it.each([
      [
        'a missing file',
        (req: ReturnType<typeof as>) =>
          req
            .post('/api/v1/ai/extractions')
            .field('contentTypeId', '0'.repeat(24))
            .field('folderId', '0'.repeat(24)),
      ],
      [
        'a malformed id',
        (req: ReturnType<typeof as>) =>
          req
            .post('/api/v1/ai/extractions')
            .field('contentTypeId', 'abc')
            .field('folderId', '0'.repeat(24))
            .attach('file', Buffer.from('x'), 'x.txt'),
      ],
      [
        'an unknown field',
        (req: ReturnType<typeof as>) =>
          req
            .post('/api/v1/ai/extractions')
            .field('contentTypeId', '0'.repeat(24))
            .field('folderId', '0'.repeat(24))
            .field('extra', '1')
            .attach('file', Buffer.from('x'), 'x.txt'),
      ],
    ])('answers 400 VALIDATION_FAILED for %s', async (_name, build) => {
      const res = await build(as(app.ctx, admin)).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('answers 404 for an unknown content type or folder', async () => {
      const missing = '0'.repeat(24);
      expect(
        (await startExtraction(app.ctx, admin, { ...ws, typeId: missing }).expect(404)).body.code,
      ).toBe('NOT_FOUND');
      expect(
        (await startExtraction(app.ctx, admin, { ...ws, folderId: missing }).expect(404)).body.code,
      ).toBe('NOT_FOUND');
    });

    it('answers 409 NO_FILLABLE_FIELDS for a type with only user fields, and 409 for an archived type', async () => {
      const onlyUser = await extractionWorkspace(app.ctx, admin, {
        ...EXTRACTION_TYPE,
        fields: [{ key: 'owner', label: 'Owner', type: 'user', required: false }],
      });
      expect((await startExtraction(app.ctx, admin, onlyUser).expect(409)).body.code).toBe(
        'NO_FILLABLE_FIELDS',
      );
      const archived = await extractionWorkspace(app.ctx, admin);
      await as(app.ctx, admin).post(`/api/v1/content-types/${archived.typeId}/archive`).expect(200);
      expect((await startExtraction(app.ctx, admin, archived).expect(409)).body.code).toBe(
        'CONTENT_TYPE_ARCHIVED',
      );
    });

    it('confirm: 400 for a bad body, 409 EXTRACTION_TYPE_MISMATCH for another content type', async () => {
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, job.id);
      const bad = await confirm(app.ctx, admin, job.id, {
        ...confirmBody(ws, {}),
        file: 'x',
      }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
      const other = await extractionWorkspace(app.ctx, admin);
      const mismatch = await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(other, { supplier: 'A', amount: 1 }),
      ).expect(409);
      expect(mismatch.body.code).toBe('EXTRACTION_TYPE_MISMATCH');
      const invalid = await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(ws, { amount: 'many' }),
      ).expect(400);
      expect(invalid.body.code).toBe('VALIDATION_FAILED');
      await confirm(app.ctx, admin, job.id, confirmBody(ws, { supplier: 'A', amount: 1 })).expect(
        201,
      );
      const again = await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(ws, { supplier: 'A', amount: 1 }),
      ).expect(409);
      expect(again.body).toMatchObject({
        code: 'EXTRACTION_NOT_CONFIRMABLE',
        details: { status: 'confirmed' },
      });
      expect(again.body.details.recordId).toMatch(/^[a-f0-9]{24}$/);
    });

    it('discards an open job (204, idempotent) and clears its suggestions and file', async () => {
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, admin, ws);
      await waitForJob(app.ctx, admin, job.id);
      await as(app.ctx, admin).delete(`/api/v1/ai/extractions/${job.id}`).expect(204);
      await as(app.ctx, admin).delete(`/api/v1/ai/extractions/${job.id}`).expect(204);
      const view = await as(app.ctx, admin).get(`/api/v1/ai/extractions/${job.id}`).expect(200);
      expect(view.body).toMatchObject({
        status: 'discarded',
        fields: null,
        file: { fileName: null },
      });
      expect(await stagedExists(app, admin.tenantId, job.id)).toBe(false);
      const confirmAfter = await confirm(
        app.ctx,
        admin,
        job.id,
        confirmBody(ws, { supplier: 'A', amount: 1 }),
      ).expect(409);
      expect(confirmAfter.body.details).toEqual({
        status: 'discarded',
        recordId: null,
        saving: false,
      });
    });
  });

  describe('members', () => {
    it('lets a member with Edit on the folder extract and confirm; without it the folder is 404', async () => {
      const member = await addMember(app.ctx, admin, 'member');
      const denied = await startExtraction(app.ctx, member, ws).expect(404);
      expect(denied.body.code).toBe('NOT_FOUND');
      await as(app.ctx, admin)
        .put('/api/v1/access/grants')
        .send({ userId: member.userId, targetType: 'folder', targetId: ws.folderId, level: 'edit' })
        .expect((res) => expect([200, 201]).toContain(res.status));
      app.ai.script(invoiceAnswer());
      const job = await startJob(app.ctx, member, ws);
      await waitForJob(app.ctx, member, job.id);
      await confirm(
        app.ctx,
        member,
        job.id,
        confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
      ).expect(201);
      await as(app.ctx, admin).get(`/api/v1/ai/extractions/${job.id}`).expect(404);
    });
  });
});
