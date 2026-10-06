import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { AiUsageService, EXTRACTION_USAGE_KIND, usageDayOf } from '../src/ai-extraction/deps.js';
import { ExtractionBlobsReader } from '../src/ai-extraction/extraction-readers.js';
import { AuditService } from '../src/audit/audit.service.js';
import { ContentTypesService } from '../src/content-types/content-types.service.js';
import { RecordsService } from '../src/records/records.service.js';
import { as, signUp, type Actor } from './helpers/actors.js';
import {
  barrier,
  confirm,
  confirmBody,
  createExtractionApp,
  extractionWorkspace,
  INVOICE_TEXT,
  invoiceAnswer,
  jobRow,
  stagedExists,
  startExtraction,
  startJob,
  waitForJob,
  type ExtractionApp,
  type ExtractionWorkspace,
} from './helpers/ai-extraction.js';
import { after } from './helpers/scripted-extraction-ai.js';

const MINUTE = 60 * 1000;

async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('AI extraction races (e2e)', () => {
  let app: ExtractionApp;
  let admin: Actor;
  let ws: ExtractionWorkspace;

  beforeAll(async () => {
    app = await createExtractionApp({ AI_EXTRACTION_STAGING_TTL_MINUTES: '1' });
    admin = await signUp(app.ctx);
    ws = await extractionWorkspace(app.ctx, admin);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const jobs = () => app.db.collection('ai_extraction_jobs');
  const userUnits = async (userId: string) => {
    const rows = await app.db
      .collection('ai_usage_daily')
      .find({ userId: new Types.ObjectId(userId), kind: 'extraction' })
      .toArray();
    return rows.reduce((total, row) => total + Number(row['turns'] ?? 0), 0);
  };

  async function readyJob(content = INVOICE_TEXT) {
    app.ai.script(invoiceAnswer());
    const job = await startJob(app.ctx, admin, ws, { content });
    await waitForJob(app.ctx, admin, job.id);
    return job;
  }

  it('(a) a confirm while the runner works: the late result is a no-op and outcomes are manual', async () => {
    let confirmed: { status: number; body: Record<string, unknown> } | null = null;
    const updateOne = vi.spyOn(app.jobs, 'updateOne');
    let jobId = '';
    app.ai.script(
      after(async () => {
        await until(() => jobId !== '');
        confirmed = await confirm(
          app.ctx,
          admin,
          jobId,
          confirmBody(ws, { supplier: 'Typed', amount: 7 }),
        );
      }, invoiceAnswer()),
    );
    jobId = (await startJob(app.ctx, admin, ws)).id;
    await waitForJob(app.ctx, admin, jobId, (job) => job.status === 'confirmed');
    await app.runner.idle();
    expect(confirmed).toMatchObject({ status: 201 });

    const readyWrites = updateOne.mock.calls.filter(
      ([, , update]) => (update as { $set?: { status?: string } }).$set?.status === 'ready',
    );
    expect(readyWrites.length).toBeGreaterThan(0);
    for (const index of updateOne.mock.calls.keys()) {
      const [, , update] = updateOne.mock.calls[index] as unknown as [
        unknown,
        unknown,
        { $set?: { status?: string } },
      ];
      if (update.$set?.status === 'ready') {
        expect(await updateOne.mock.results[index]?.value).toBeNull();
      }
    }
    const row = await jobRow(app, jobId);
    expect(row).toMatchObject({ status: 'confirmed', fields: null, errorReason: 'confirm' });
    const review = row?.['review'] as Array<{ outcome: string; suggestedStatus: string }>;
    expect(review.every((r) => r.suggestedStatus === 'none')).toBe(true);
    expect(review.filter((r) => r.outcome === 'manual')).toHaveLength(2);
  });

  it('(b) a double confirm: one 201, one 409; a later confirm gets the recordId', async () => {
    const job = await readyJob();
    const before = await app.db.collection('records').countDocuments({});
    const body = confirmBody(ws, { supplier: 'Acme Corp', amount: 1 });
    const [first, second] = await Promise.all([
      confirm(app.ctx, admin, job.id, body),
      confirm(app.ctx, admin, job.id, body),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    const winner = first.status === 201 ? first : second;
    expect(loser.body.code).toBe('EXTRACTION_NOT_CONFIRMABLE');
    expect(await app.db.collection('records').countDocuments({})).toBe(before + 1);
    const later = await confirm(app.ctx, admin, job.id, body).expect(409);
    expect(later.body.details).toEqual({
      status: 'confirmed',
      recordId: winner.body.id,
      saving: false,
    });
  });

  it('(b2) a confirmed job holds no claim, and the resolver never re-reads a confirmed row', async () => {
    const job = await readyJob();
    await confirm(
      app.ctx,
      admin,
      job.id,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
    const row = await jobRow(app, job.id);
    expect(row).toMatchObject({
      status: 'confirmed',
      confirmToken: null,
      confirmClaimedAt: null,
      confirmTarget: null,
    });
    const blobs = vi.spyOn(app.ctx.app.get(ExtractionBlobsReader), 'findOne');
    const later = new Date(Date.now() + app.settings.confirmStaleMs + MINUTE);
    expect(await app.housekeeping.housekeep({ now: later })).toMatchObject({
      resolved: 0,
      claimsCleared: 0,
    });

    await jobs().updateOne(
      { _id: new Types.ObjectId(job.id) },
      {
        $set: {
          confirmToken: 'kept-claim',
          confirmClaimedAt: row?.['confirmedAt'],
          confirmTarget: {
            name: 'Invoice INV-2026-042',
            folderId: new Types.ObjectId(ws.folderId),
          },
        },
      },
    );
    expect(await app.housekeeping.housekeep({ now: later })).toMatchObject({
      resolved: 0,
      claimsCleared: 0,
    });
    expect(blobs).not.toHaveBeenCalled();
    expect(await jobRow(app, job.id)).toMatchObject({
      status: 'confirmed',
      confirmToken: 'kept-claim',
    });
    const again = await confirm(
      app.ctx,
      admin,
      job.id,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    );
    expect(again.body.details).toEqual({
      status: 'confirmed',
      recordId: String(row?.['recordId']),
      saving: false,
    });
  });

  it('(c) housekeeping between the claim and create leaves the file and the job confirms', async () => {
    const job = await readyJob();
    const open = app.storage.open.bind(app.storage);
    let ran = false;
    const spy = vi.spyOn(app.storage, 'open').mockImplementationOnce(async (key) => {
      await app.housekeeping.housekeep({ now: new Date(Date.now() + 12 * MINUTE) });
      ran = true;
      return open(key);
    });
    await confirm(
      app.ctx,
      admin,
      job.id,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
    expect(spy).toHaveBeenCalled();
    expect(ran).toBe(true);
    expect((await jobRow(app, job.id))?.['status']).toBe('confirmed');
  });

  it('(c2) a confirm still running past the stale limit is never resolved', async () => {
    const job = await readyJob();
    const open = app.storage.open.bind(app.storage);
    let pass: Awaited<ReturnType<typeof app.housekeeping.housekeep>> | null = null;
    const spy = vi.spyOn(app.storage, 'open').mockImplementationOnce(async (key) => {
      pass = await app.housekeeping.housekeep({
        now: new Date(Date.now() + app.settings.confirmStaleMs + MINUTE),
      });
      return open(key);
    });
    const created = await confirm(
      app.ctx,
      admin,
      job.id,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
    expect(spy).toHaveBeenCalled();
    expect(pass).toMatchObject({ resolved: 0, claimsCleared: 0 });
    const row = await jobRow(app, job.id);
    expect(row).toMatchObject({ status: 'confirmed' });
    expect(String(row?.['recordId'])).toBe(created.body.id);
  });

  it('(d) a discard between the claim and create is refused; the job confirms', async () => {
    const job = await readyJob();
    const open = app.storage.open.bind(app.storage);
    let discard = 0;
    const spy = vi.spyOn(app.storage, 'open').mockImplementationOnce(async (key) => {
      discard = (await as(app.ctx, admin).delete(`/api/v1/ai/extractions/${job.id}`)).status;
      expect(await stagedExists(app, admin.tenantId, job.id)).toBe(true);
      return open(key);
    });
    await confirm(
      app.ctx,
      admin,
      job.id,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
    expect(spy).toHaveBeenCalled();
    expect(discard).toBe(409);
    expect((await jobRow(app, job.id))?.['status']).toBe('confirmed');
  });

  function failFinishWrites(times = 2) {
    const updateRow = app.jobs.updateRow.bind(app.jobs);
    let failures = 0;
    return vi.spyOn(app.jobs, 'updateRow').mockImplementation(async (row, filter, update) => {
      const status = (update as { $set?: { status?: string } }).$set?.status;
      if (status === 'confirmed' && failures < times) {
        failures += 1;
        throw new Error('Scripted write failure');
      }
      return updateRow(row, filter, update);
    });
  }

  async function recordsNamed(name: string) {
    return app.db.collection('records').countDocuments({ name });
  }

  it.each([
    ['(e) without a restart', false],
    ['(e2) with a restart (bootstrap pass)', true],
  ])(
    '%s: create returned but the finish write failed twice → 201, then the resolver binds it',
    async (_name, bootstrap) => {
      const job = await readyJob(`${INVOICE_TEXT}Run: e-${String(bootstrap)}\n`);
      const name = `Recovered ${String(bootstrap)}`;
      const body = confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }, { name });
      const spy = failFinishWrites();
      const created = await confirm(app.ctx, admin, job.id, body).expect(201);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
      const claimed = await jobRow(app, job.id);
      expect(claimed).toMatchObject({ status: 'ready', recordId: null });
      expect(claimed?.['confirmToken']).toEqual(expect.any(String));

      const again = await confirm(app.ctx, admin, job.id, body).expect(409);
      expect(again.body.details).toEqual({ status: 'ready', recordId: null, saving: true });
      expect(await recordsNamed(name)).toBe(1);

      const result = await app.housekeeping.housekeep({
        bootstrap,
        now: new Date(Date.now() + 16 * MINUTE),
      });
      expect(result.resolved).toBeGreaterThanOrEqual(1);
      const finished = await jobRow(app, job.id);
      expect(finished).toMatchObject({
        status: 'confirmed',
        confirmToken: null,
        confirmClaimedAt: null,
      });
      expect(String(finished?.['recordId'])).toBe(created.body.id);
      expect(await recordsNamed(name)).toBe(1);
      expect(await stagedExists(app, admin.tenantId, job.id)).toBe(false);
      const audit = await as(app.ctx, admin)
        .get('/api/v1/audit?action=AI_EXTRACTION_CONFIRMED&pageSize=5')
        .expect(200);
      const entry = (
        audit.body.items as Array<{ resource: { id: string }; context: Record<string, unknown> }>
      ).find((item) => item.resource.id === created.body.id);
      expect(entry?.context).toMatchObject({ jobId: job.id, recovered: true });
    },
  );

  it('(e3) two jobs of one user with the same file, one record, a crash: only one job binds', async () => {
    const content = `${INVOICE_TEXT}Run: e3\n`;
    const first = await readyJob(content);
    const second = await readyJob(content);
    const name = 'Recovered once';
    const body = confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }, { name });
    const spy = failFinishWrites();
    const created = await confirm(app.ctx, admin, first.id, body).expect(201);
    spy.mockRestore();
    const firstRow = await jobRow(app, first.id);
    await jobs().updateOne(
      { _id: new Types.ObjectId(second.id) },
      {
        $set: {
          confirmToken: 'crashed-confirm',
          confirmClaimedAt: firstRow?.['confirmClaimedAt'],
          confirmTarget: firstRow?.['confirmTarget'],
          expiresAt: new Date(Date.now() + 30 * MINUTE),
        },
      },
    );
    await app.housekeeping.housekeep({ now: new Date(Date.now() + 16 * MINUTE) });
    const bound = await jobs().countDocuments({ recordId: new Types.ObjectId(created.body.id) });
    expect(bound).toBe(1);
    const rows = [await jobRow(app, first.id), await jobRow(app, second.id)];
    expect(rows.map((row) => String(row?.['status'])).sort((a, b) => a.localeCompare(b))).toEqual([
      'confirmed',
      'ready',
    ]);
    const unbound = rows.find((row) => row?.['status'] === 'ready');
    expect(unbound?.['confirmToken']).toBeNull();
    expect(await recordsNamed(name)).toBe(1);
  });

  it('(e4) create fails after the record was stored (a 500): the claim stays and the resolver binds it', async () => {
    const job = await readyJob(`${INVOICE_TEXT}Run: e4\n`);
    const name = 'Stored, then a 500';
    const body = confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }, { name });
    const audit = app.ctx.app.get(AuditService);
    const record = audit.record.bind(audit);
    let thrown = false;
    vi.spyOn(audit, 'record').mockImplementation(async (tenantId, input) => {
      if (input.action === 'RECORD_CREATED' && !thrown) {
        thrown = true;
        throw new Error('Scripted audit failure');
      }
      return record(tenantId, input);
    });
    const failed = await confirm(app.ctx, admin, job.id, body).expect(500);
    expect(failed.body.code).toBe('INTERNAL_ERROR');
    expect(thrown).toBe(true);
    vi.restoreAllMocks();
    expect(await recordsNamed(name)).toBe(1);
    const claimed = await jobRow(app, job.id);
    expect(claimed).toMatchObject({ status: 'ready', recordId: null });
    expect(claimed?.['confirmToken']).toEqual(expect.any(String));

    const pass = await app.housekeeping.housekeep({ now: new Date(Date.now() + 16 * MINUTE) });
    expect(pass.resolved).toBe(1);
    expect(await recordsNamed(name)).toBe(1);
    const stored = await app.db.collection('records').findOne({ name });
    const again = await confirm(app.ctx, admin, job.id, body).expect(409);
    expect(again.body.details).toEqual({
      status: 'confirmed',
      recordId: String(stored?._id),
      saving: false,
    });
  });

  it('(f) a periodic pass between insert and stage: the file survives and the job becomes ready', async () => {
    const putFromPath = app.storage.putFromPath.bind(app.storage);
    let pass: Awaited<ReturnType<typeof app.housekeeping.housekeep>> | null = null;
    const spy = vi.spyOn(app.storage, 'putFromPath').mockImplementationOnce(async (key, source) => {
      pass = await app.housekeeping.housekeep();
      return putFromPath(key, source);
    });
    app.ai.script(invoiceAnswer());
    const job = await startJob(app.ctx, admin, ws);
    expect(spy).toHaveBeenCalled();
    expect(pass).toMatchObject({ stuck: 0, missingFiles: 0 });
    const ready = await waitForJob(app.ctx, admin, job.id);
    expect(ready.status).toBe('ready');
    expect(await stagedExists(app, admin.tenantId, job.id)).toBe(true);
  });

  it('(h) confirming a processing job with invalid metadata: 400, the job fails, a new job starts, expiry removes the file', async () => {
    let refused = 0;
    let jobId = '';
    app.ai.script(
      after(async () => {
        await until(() => jobId !== '');
        refused = (await confirm(app.ctx, admin, jobId, confirmBody(ws, { amount: 'lots' })))
          .status;
      }, invoiceAnswer()),
    );
    jobId = (await startJob(app.ctx, admin, ws)).id;
    await waitForJob(app.ctx, admin, jobId, (job) => job.status === 'failed');
    await app.runner.idle();
    expect(refused).toBe(400);
    const failed = await as(app.ctx, admin).get(`/api/v1/ai/extractions/${jobId}`).expect(200);
    expect(failed.body).toMatchObject({
      status: 'failed',
      errorCode: 'EXTRACTION_INTERRUPTED',
      errorReason: 'confirm',
      retryable: false,
    });
    expect((await jobRow(app, jobId))?.['confirmToken']).toBeNull();

    app.ai.script(invoiceAnswer());
    const next = await startJob(app.ctx, admin, ws);
    await waitForJob(app.ctx, admin, next.id);

    const row = await jobRow(app, jobId);
    const expiresAt = row?.['expiresAt'] as Date;
    await app.housekeeping.housekeep({ now: new Date(expiresAt.getTime() + 1000) });
    expect(await jobRow(app, jobId)).toMatchObject({ status: 'expired', fields: null });
    expect(await stagedExists(app, admin.tenantId, jobId)).toBe(false);
  });

  it('(i) the stuck-row net and the looping bootstrap pass', async () => {
    const tenantId = new Types.ObjectId(admin.tenantId);
    const userId = new Types.ObjectId();
    const base = {
      tenantId,
      userId,
      stage: 'fields',
      contentTypeId: new Types.ObjectId(ws.typeId),
      schemaVersion: 1,
      folderId: new Types.ObjectId(ws.folderId),
      text: { source: null, charsSent: 0, truncated: false },
      fields: null,
      review: null,
      usage: { model: null, inputTokens: null, outputTokens: null, calls: 0, durationMs: null },
      usageDay: '2026-01-01',
      errorCode: null,
      errorReason: null,
      confirmToken: null,
      confirmClaimedAt: null,
      confirmTarget: null,
      recordId: null,
      finishedAt: null,
      confirmedAt: null,
    };
    const stuckId = new Types.ObjectId();
    const key = `ai-staging/${admin.tenantId}/${stuckId.toHexString()}`;
    const source = join(app.settings.storageDir, `stuck-${stuckId.toHexString()}`);
    await writeFile(source, 'stuck');
    await app.storage.putFromPath(key, source);
    const old = new Date(Date.now() - app.settings.timeoutMs - 2 * MINUTE);
    await jobs().insertOne({
      ...base,
      _id: stuckId,
      status: 'processing',
      leaseToken: 'dead-runner',
      file: {
        fileName: 'x.txt',
        declaredMimeType: 'text/plain',
        kind: 'text',
        size: 5,
        sha256: 'x',
        stagingKey: key,
      },
      expiresAt: new Date(Date.now() + MINUTE),
      createdAt: old,
      updatedAt: old,
    });
    const periodic = await app.housekeeping.housekeep();
    expect(periodic.stuck).toBeGreaterThanOrEqual(1);
    expect(await jobRow(app, stuckId.toHexString())).toMatchObject({
      status: 'failed',
      errorCode: 'EXTRACTION_INTERRUPTED',
      errorReason: 'restart',
      leaseToken: null,
      file: expect.objectContaining({ stagingKey: null }),
    });
    expect(await app.storage.exists(key)).toBe(false);

    const now = new Date();
    await jobs().insertMany(
      Array.from({ length: 201 }, () => ({
        ...base,
        _id: new Types.ObjectId(),
        status: 'queued',
        stage: null,
        leaseToken: null,
        file: {
          fileName: 'q.txt',
          declaredMimeType: 'text/plain',
          kind: 'text',
          size: 1,
          sha256: 'q',
          stagingKey: null,
        },
        expiresAt: new Date(now.getTime() + MINUTE),
        createdAt: now,
        updatedAt: now,
      })),
    );
    const bootstrap = await app.housekeeping.housekeep({ bootstrap: true });
    expect(bootstrap.interrupted).toBeGreaterThanOrEqual(201);
    expect(await jobs().countDocuments({ tenantId, status: 'queued' })).toBe(0);
  });

  it('(i2) the bootstrap pass gives back the unit of a queued row, never of a processing one', async () => {
    await app.runner.idle();
    const usage = app.ctx.app.get(AiUsageService);
    const day = usageDayOf();
    const unitsBefore = await userUnits(admin.userId);
    const row = (status: 'queued' | 'processing') => ({
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(admin.tenantId),
      userId: new Types.ObjectId(admin.userId),
      status,
      stage: status === 'queued' ? null : 'fields',
      contentTypeId: new Types.ObjectId(ws.typeId),
      schemaVersion: 1,
      folderId: new Types.ObjectId(ws.folderId),
      file: {
        fileName: 'u.txt',
        declaredMimeType: 'text/plain',
        kind: 'text',
        size: 1,
        sha256: 'u',
        stagingKey: null,
      },
      text: { source: null, charsSent: 0, truncated: false },
      fields: null,
      review: null,
      usage: { model: null, inputTokens: null, outputTokens: null, calls: 0, durationMs: null },
      usageDay: day,
      errorCode: null,
      errorReason: null,
      leaseToken: status === 'queued' ? null : 'dead-runner',
      confirmToken: null,
      confirmClaimedAt: null,
      confirmTarget: null,
      recordId: null,
      expiresAt: new Date(Date.now() + MINUTE),
      finishedAt: null,
      confirmedAt: null,
    });
    for (let i = 0; i < 2; i += 1) {
      await usage.claim(admin.tenantId, admin.userId, EXTRACTION_USAGE_KIND, 1000, day);
      await usage.claim(admin.tenantId, null, EXTRACTION_USAGE_KIND, 10000, day);
    }
    const queued = row('queued');
    const processing = row('processing');
    await jobs().insertMany([queued, processing]);
    const pass = await app.housekeeping.housekeep({ bootstrap: true });
    expect(pass.interrupted).toBeGreaterThanOrEqual(2);
    expect(await jobRow(app, queued._id.toHexString())).toMatchObject({
      status: 'failed',
      errorReason: 'restart',
    });
    expect(await jobRow(app, processing._id.toHexString())).toMatchObject({
      status: 'failed',
      errorReason: 'restart',
    });
    expect(await userUnits(admin.userId)).toBe(unitsBefore + 1);
    await jobs().updateMany(
      { _id: { $in: [queued._id, processing._id] } },
      { $set: { status: 'discarded' } },
    );
  });

  it('(j) a failed removal on discard leaves the key; the next pass removes the file and clears it', async () => {
    const job = await readyJob();
    const spy = vi.spyOn(app.storage, 'remove').mockRejectedValueOnce(new Error('Disk busy'));
    await as(app.ctx, admin).delete(`/api/v1/ai/extractions/${job.id}`).expect(204);
    expect(spy).toHaveBeenCalled();
    const discarded = await jobRow(app, job.id);
    expect(discarded).toMatchObject({ status: 'discarded', fields: null });
    expect((discarded?.['file'] as { stagingKey: string | null } | undefined)?.stagingKey).toEqual(
      expect.any(String),
    );
    expect(await stagedExists(app, admin.tenantId, job.id)).toBe(true);
    const pass = await app.housekeeping.housekeep();
    expect(pass.unstaged).toBeGreaterThanOrEqual(1);
    expect(
      ((await jobRow(app, job.id))?.['file'] as { stagingKey: string | null } | undefined)
        ?.stagingKey,
    ).toBeNull();
    expect(await stagedExists(app, admin.tenantId, job.id)).toBe(false);
  });

  it('(k) a staging failure at upload leaves no row, no staged file, and gives the daily unit back', async () => {
    await app.runner.idle();
    const rowsBefore = await jobs().countDocuments({});
    const unitsBefore = await userUnits(admin.userId);
    const spy = vi.spyOn(app.storage, 'putFromPath').mockRejectedValueOnce(new Error('Disk full'));
    const res = await startExtraction(app.ctx, admin, ws).expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(spy).toHaveBeenCalled();
    const [key] = spy.mock.calls[0] as [string, string];
    expect(await app.storage.exists(key)).toBe(false);
    expect(await jobs().countDocuments({})).toBe(rowsBefore);
    expect(await userUnits(admin.userId)).toBe(unitsBefore);
  });

  describe('(g) concurrent starts: insert, then count every other row', () => {
    it('in-flight cap 1: both inserts land before either count → at most one 202, the rest 429', async () => {
      await app.runner.idle();
      const contentTypes = app.ctx.app.get(ContentTypesService);
      const require = contentTypes.require.bind(contentTypes);
      const insert = app.jobs.insert.bind(app.jobs);
      const pastGuard = barrier(2);
      const inserted = barrier(2);
      vi.spyOn(contentTypes, 'require').mockImplementation(async (...args) => {
        await pastGuard.wait();
        return require(...args);
      });
      const insertSpy = vi.spyOn(app.jobs, 'insert').mockImplementation(async (...args) => {
        const doc = await insert(...args);
        await inserted.wait();
        return doc;
      });
      let releaseModel!: () => void;
      const modelGate = new Promise<void>((resolve) => (releaseModel = resolve));
      app.ai.script(
        after(() => modelGate, invoiceAnswer()),
        invoiceAnswer(),
      );
      const unitsBefore = await userUnits(admin.userId);
      const results = await Promise.all([
        startExtraction(app.ctx, admin, ws),
        startExtraction(app.ctx, admin, ws),
      ]);
      releaseModel();
      expect(insertSpy).toHaveBeenCalledTimes(2);
      const accepted = results.filter((res) => res.status === 202);
      expect(accepted.length).toBeLessThanOrEqual(1);
      for (const busy of results.filter((res) => res.status !== 202)) {
        expect(busy.status).toBe(429);
        expect(busy.body).toMatchObject({ code: 'AI_EXTRACTION_BUSY', details: { scope: 'user' } });
      }
      expect(await userUnits(admin.userId)).toBe(unitsBefore + accepted.length);
      for (const winner of accepted) await waitForJob(app.ctx, admin, winner.body.id as string);
    });

    it('(g2) an insert that lands after another request counted is refused by its own count', async () => {
      await app.runner.idle();
      const insert = app.jobs.insert.bind(app.jobs);
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
        setTimeout(resolve, 3000).unref();
      });
      let calls = 0;
      const insertSpy = vi.spyOn(app.jobs, 'insert').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) await firstHeld;
        return insert(...args);
      });
      let releaseModel!: () => void;
      const modelGate = new Promise<void>((resolve) => (releaseModel = resolve));
      app.ai.script(
        after(() => modelGate, invoiceAnswer()),
        invoiceAnswer(),
      );
      const answered: number[] = [];
      const send = () =>
        startExtraction(app.ctx, admin, ws).then((res) => {
          answered.push(res.status);
          if (answered.length === 1) releaseFirst();
          return res;
        });
      const results = await Promise.all([send(), send()]);
      releaseModel();
      expect(insertSpy).toHaveBeenCalledTimes(2);
      expect(answered).toEqual([202, 429]);
      const busy = results.find((res) => res.status === 429);
      expect(busy?.body).toMatchObject({ code: 'AI_EXTRACTION_BUSY', details: { scope: 'user' } });
      const winner = results.find((res) => res.status === 202);
      await waitForJob(app.ctx, admin, winner?.body.id as string);
    });
  });
});

describe('AI extraction races: the in-flight cap 3 (e2e)', () => {
  let app: ExtractionApp;
  let admin: Actor;
  let ws: ExtractionWorkspace;

  beforeAll(async () => {
    app = await createExtractionApp({ AI_EXTRACTION_USER_IN_FLIGHT: '3' });
    admin = await signUp(app.ctx);
    ws = await extractionWorkspace(app.ctx, admin);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(g3) four concurrent starts against a cap of 3: never more than 3 in flight', async () => {
    const contentTypes = app.ctx.app.get(ContentTypesService);
    const require = contentTypes.require.bind(contentTypes);
    const pastGuard = barrier(4);
    vi.spyOn(contentTypes, 'require').mockImplementation(async (...args) => {
      await pastGuard.wait();
      return require(...args);
    });
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => (releaseModel = resolve));
    app.ai.script(...Array.from({ length: 4 }, () => after(() => modelGate, invoiceAnswer())));
    const results = await Promise.all(
      Array.from({ length: 4 }, () => startExtraction(app.ctx, admin, ws)),
    );
    const inFlight = await app.db
      .collection('ai_extraction_jobs')
      .countDocuments({ status: { $in: ['queued', 'processing'] } });
    releaseModel();
    const accepted = results.filter((res) => res.status === 202);
    expect(accepted.length).toBeLessThanOrEqual(3);
    expect(inFlight).toBe(accepted.length);
    for (const busy of results.filter((res) => res.status !== 202)) {
      expect(busy.status).toBe(429);
      expect(busy.body).toMatchObject({ code: 'AI_EXTRACTION_BUSY', details: { scope: 'user' } });
    }
    expect(await app.db.collection('ai_extraction_jobs').countDocuments({})).toBe(accepted.length);
    for (const winner of accepted) await waitForJob(app.ctx, admin, winner.body.id as string);
  });
});

describe('AI extraction races: the open-job cap (e2e)', () => {
  let app: ExtractionApp;
  let admin: Actor;
  let ws: ExtractionWorkspace;

  beforeAll(async () => {
    app = await createExtractionApp({
      AI_EXTRACTION_USER_IN_FLIGHT: '5',
      AI_EXTRACTION_USER_OPEN_JOBS: '1',
    });
    admin = await signUp(app.ctx);
    ws = await extractionWorkspace(app.ctx, admin);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  it('(g) open-job cap 1: at most one 202, the rest 429, and no row is left for a loser', async () => {
    const insert = app.jobs.insert.bind(app.jobs);
    const inserted = barrier(2);
    const contentTypes = app.ctx.app.get(ContentTypesService);
    const require = contentTypes.require.bind(contentTypes);
    const pastGuard = barrier(2);
    vi.spyOn(contentTypes, 'require').mockImplementation(async (...args) => {
      await pastGuard.wait();
      return require(...args);
    });
    vi.spyOn(app.jobs, 'insert').mockImplementation(async (...args) => {
      const doc = await insert(...args);
      await inserted.wait();
      return doc;
    });
    app.ai.script(invoiceAnswer(), invoiceAnswer());
    const results = await Promise.all([
      startExtraction(app.ctx, admin, ws),
      startExtraction(app.ctx, admin, ws),
    ]);
    vi.restoreAllMocks();
    const accepted = results.filter((res) => res.status === 202);
    expect(accepted.length).toBeLessThanOrEqual(1);
    expect(results.filter((res) => res.status === 429)).toHaveLength(
      results.length - accepted.length,
    );
    expect(await app.db.collection('ai_extraction_jobs').countDocuments({})).toBe(accepted.length);
    for (const winner of accepted) {
      await waitForJob(app.ctx, admin, winner.body.id as string);
      await as(app.ctx, admin)
        .delete(`/api/v1/ai/extractions/${winner.body.id as string}`)
        .expect(204);
    }
  });

  it('keeps RecordsService.create untouched by the feature (it is called with the request principal)', async () => {
    const records = app.ctx.app.get(RecordsService);
    const spy = vi.spyOn(records, 'create');
    app.ai.script(invoiceAnswer());
    const job = await startJob(app.ctx, admin, ws);
    await waitForJob(app.ctx, admin, job.id);
    await confirm(
      app.ctx,
      admin,
      job.id,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
    expect(spy).toHaveBeenCalledTimes(1);
    const [principal, input, upload] = spy.mock.calls[0] ?? [];
    expect(principal).toMatchObject({ userId: admin.userId, tenantId: admin.tenantId });
    expect(input).toMatchObject({ contentTypeId: ws.typeId, folderId: ws.folderId });
    expect(upload).toMatchObject({ originalName: 'invoice.txt', mimeType: 'text/plain' });
    spy.mockRestore();
  });
});
