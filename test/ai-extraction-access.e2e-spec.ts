import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import {
  confirm,
  confirmBody,
  createExtractionApp,
  extractionWorkspace,
  invoiceAnswer,
  jobRow,
  stagedExists,
  startExtraction,
  startJob,
  waitForJob,
  withoutRequestId,
  type ExtractionApp,
  type ExtractionWorkspace,
} from './helpers/ai-extraction.js';

describe('AI extraction ownership and tenant isolation (e2e)', () => {
  let app: ExtractionApp;
  let owner: Actor;
  let colleague: Actor;
  let stranger: Actor;
  let ws: ExtractionWorkspace;
  let strangerWs: ExtractionWorkspace;
  let jobId: string;
  const missingId = '0123456789abcdef01234567';

  beforeAll(async () => {
    app = await createExtractionApp();
    owner = await signUp(app.ctx, { tenantName: 'Owner tenant' });
    colleague = await addMember(app.ctx, owner, 'admin');
    stranger = await signUp(app.ctx, { tenantName: 'Stranger tenant' });
    ws = await extractionWorkspace(app.ctx, owner);
    strangerWs = await extractionWorkspace(app.ctx, stranger);
    app.ai.script(invoiceAnswer());
    jobId = (await startJob(app.ctx, owner, ws)).id;
    await waitForJob(app.ctx, owner, jobId);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  async function outsiders(
    send: (actor: Actor, id: string) => Promise<{ status: number; body: Record<string, unknown> }>,
  ) {
    const answers = [
      await send(colleague, jobId),
      await send(stranger, jobId),
      await send(owner, missingId),
    ];
    for (const res of answers) expect(res.status).toBe(404);
    const bodies = answers.map((res) => withoutRequestId(res.body));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual(bodies[2]);
    expect(bodies[0]).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  }

  it('identical 404 for another user, another tenant and a missing id', async () => {
    await outsiders((actor, id) => as(app.ctx, actor).get(`/api/v1/ai/extractions/${id}`));
    await as(app.ctx, owner).get(`/api/v1/ai/extractions/${jobId}`).expect(200);
    await as(app.ctx, owner).get('/api/v1/ai/extractions/not-an-id').expect(404);
  });

  it('identical 404, and nothing is created or claimed', async () => {
    const before = await app.db.collection('records').countDocuments({});
    await outsiders((actor, id) =>
      confirm(app.ctx, actor, id, confirmBody(ws, { supplier: 'Acme Corp', amount: 1 })),
    );
    expect(await app.db.collection('records').countDocuments({})).toBe(before);
    expect((await jobRow(app, jobId))?.['confirmToken']).toBeNull();
  });

  it('identical 404, and the job and its staged file stay', async () => {
    await outsiders((actor, id) => as(app.ctx, actor).delete(`/api/v1/ai/extractions/${id}`));
    expect((await jobRow(app, jobId))?.['status']).toBe('ready');
    expect(await stagedExists(app, owner.tenantId, jobId)).toBe(true);
  });

  it("another tenant's content type or folder is 404", async () => {
    const foreignType = await startExtraction(app.ctx, owner, {
      typeId: strangerWs.typeId,
      folderId: ws.folderId,
    }).expect(404);
    expect(foreignType.body.code).toBe('NOT_FOUND');
    const foreignFolder = await startExtraction(app.ctx, owner, {
      typeId: ws.typeId,
      folderId: strangerWs.folderId,
    }).expect(404);
    expect(foreignFolder.body.code).toBe('NOT_FOUND');
  });

  it("confirming into another tenant's folder is refused by create", async () => {
    app.ai.script(invoiceAnswer());
    const job = await startJob(app.ctx, owner, ws);
    await waitForJob(app.ctx, owner, job.id);
    const res = await confirm(
      app.ctx,
      owner,
      job.id,
      confirmBody(
        { typeId: ws.typeId, folderId: strangerWs.folderId },
        { supplier: 'A', amount: 1 },
      ),
    ).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
    await confirm(app.ctx, owner, job.id, confirmBody(ws, { supplier: 'A', amount: 1 })).expect(
      201,
    );
  });

  it('the owner confirms the original job', async () => {
    await confirm(
      app.ctx,
      owner,
      jobId,
      confirmBody(ws, { supplier: 'Acme Corp', amount: 1 }),
    ).expect(201);
  });
});
