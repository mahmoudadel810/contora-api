import { Types } from 'mongoose';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import {
  confirm,
  confirmBody,
  createExtractionApp,
  extractionWorkspace,
  INVOICE_TEXT,
  invoiceAnswer,
  jobRow,
  stagedExists,
  startJob,
  waitForJob,
  type ExtractionApp,
  type ExtractionWorkspace,
} from './helpers/ai-extraction.js';
import { answer } from './helpers/scripted-extraction-ai.js';

const MINUTE = 60 * 1000;

describe('AI extraction privacy and lifecycle (e2e)', () => {
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

  async function readyJob(actor: Actor = admin, target: ExtractionWorkspace = ws) {
    app.ai.script(invoiceAnswer());
    const job = await startJob(app.ctx, actor, target);
    await waitForJob(app.ctx, actor, job.id);
    return job;
  }

  it('nulls snippets at confirm, keeps values and outcomes, and removes the staged file', async () => {
    const job = await readyJob();
    expect(await stagedExists(app, admin.tenantId, job.id)).toBe(true);
    await confirm(
      app.ctx,
      admin,
      job.id,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
    const view = await as(app.ctx, admin).get(`/api/v1/ai/extractions/${job.id}`).expect(200);
    const fields = view.body.fields as Array<{ status: string; sourceSnippet: string | null }>;
    expect(fields.filter((f) => f.status === 'filled').length).toBeGreaterThan(0);
    expect(fields.every((f) => f.sourceSnippet === null)).toBe(true);
    expect(await stagedExists(app, admin.tenantId, job.id)).toBe(false);
    expect((await jobRow(app, job.id))?.['review']).toEqual(expect.any(Array));
    expect(view.body).not.toHaveProperty('review');
  });

  it('nulls fields, file name and hash on discard and on expiry, and removes the staged file', async () => {
    const discarded = await readyJob();
    await as(app.ctx, admin).delete(`/api/v1/ai/extractions/${discarded.id}`).expect(204);
    expect(await jobRow(app, discarded.id)).toMatchObject({
      status: 'discarded',
      fields: null,
      file: expect.objectContaining({ fileName: null, sha256: null, stagingKey: null }),
    });
    expect(await stagedExists(app, admin.tenantId, discarded.id)).toBe(false);

    const expiring = await readyJob();
    await app.housekeeping.housekeep({ now: new Date(Date.now() + 2 * MINUTE) });
    expect(await jobRow(app, expiring.id)).toMatchObject({
      status: 'expired',
      fields: null,
      file: expect.objectContaining({ fileName: null, sha256: null, stagingKey: null }),
    });
    expect(await stagedExists(app, admin.tenantId, expiring.id)).toBe(false);
  });

  it('stores snippets without bidi or zero-width characters, ending on a whole code point', async () => {
    const emoji = '😀'.repeat(130);
    const document = `${INVOICE_TEXT}Notes: ‫Signed​ ${emoji}\n`;
    app.ai.script(
      answer({
        supplier: { value: 'Acme Corp', confidence: 0.9, sourceSnippet: 'Supplier: Acme‏ Corp' },
        invoiceNumber: { value: null, confidence: 0, sourceSnippet: null },
        amount: { value: null, confidence: 0, sourceSnippet: null },
        dueDate: { value: null, confidence: 0, sourceSnippet: null },
        status: { value: null, confidence: 0, sourceSnippet: null },
      }),
    );
    const job = await startJob(app.ctx, admin, ws, { content: document });
    const ready = await waitForJob(app.ctx, admin, job.id);
    const snippet = ready.fields?.find((f) => f.key === 'supplier')?.sourceSnippet ?? '';
    expect(snippet).toBe('Supplier: Acme Corp');
    expect(snippet).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/);
    await as(app.ctx, admin).delete(`/api/v1/ai/extractions/${job.id}`).expect(204);
  });

  it('purging a folder deletes the job rows of the records in it', async () => {
    const folder = await as(app.ctx, admin)
      .post('/api/v1/folders')
      .send({ name: 'To purge', parentId: ws.rootId })
      .expect(201);
    const target = { ...ws, folderId: folder.body.id as string };
    const job = await readyJob(admin, target);
    const created = await confirm(
      app.ctx,
      admin,
      job.id,
      confirmBody(target, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
    expect((await jobRow(app, job.id))?.['recordId']).toEqual(new Types.ObjectId(created.body.id));
    await as(app.ctx, admin).delete(`/api/v1/folders/${target.folderId}`).expect(204);
    await as(app.ctx, admin).delete(`/api/v1/trash/folders/${target.folderId}`).expect(200);
    expect(await jobRow(app, job.id)).toBeNull();
  });

  it('removing a member discards their open jobs and unstages them; confirmed rows stay', async () => {
    const member = await addMember(app.ctx, admin, 'admin');
    const confirmed = await readyJob(member);
    await confirm(
      app.ctx,
      member,
      confirmed.id,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
    const open = await readyJob(member);
    await as(app.ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
    expect(await jobRow(app, open.id)).toMatchObject({ status: 'discarded', fields: null });
    expect(await stagedExists(app, admin.tenantId, open.id)).toBe(false);
    expect((await jobRow(app, confirmed.id))?.['status']).toBe('confirmed');
  });
});
