import { as, signUp, type Actor } from './helpers/actors.js';
import { AI_DISABLED_ENV, chat, chatBody } from './helpers/ai.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const UNKNOWN_ID = 'a'.repeat(24);

describe('AI assistant without configuration (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;

  beforeAll(async () => {
    ctx = await createTestApp([], AI_DISABLED_ENV);
    admin = await signUp(ctx);
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('reports not configured, never 503', async () => {
    const res = await as(ctx, admin).get('/api/v1/ai/status').expect(200);
    expect(res.body).toEqual({
      enabled: false,
      reason: 'NOT_CONFIGURED',
      model: null,
      maxMessageChars: 4000,
      actionTimeoutMs: 120000,
      domains: [],
    });
  });

  it('refuses a chat with 503 AI_DISABLED, the same for any body', async () => {
    const valid = await chat(ctx, admin, chatBody());
    expect(valid.status).toBe(503);
    expect(valid.body).toMatchObject({ statusCode: 503, code: 'AI_DISABLED' });
    const invalid = await chat(ctx, admin, { nonsense: true });
    expect(invalid.status).toBe(503);
    expect(invalid.body.code).toBe('AI_DISABLED');
  });

  it('keeps the personal session routes working: empty list and 404 for any id', async () => {
    const list = await as(ctx, admin).get('/api/v1/ai/sessions').expect(200);
    expect(list.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    const get = await as(ctx, admin).get(`/api/v1/ai/sessions/${UNKNOWN_ID}`).expect(404);
    expect(get.body.code).toBe('NOT_FOUND');
    await as(ctx, admin)
      .patch(`/api/v1/ai/sessions/${UNKNOWN_ID}`)
      .send({ title: 'x' })
      .expect(404);
    await as(ctx, admin).delete(`/api/v1/ai/sessions/${UNKNOWN_ID}`).expect(404);
    await as(ctx, admin).get('/api/v1/ai/sessions/not-an-id').expect(404);
  });

  it('keeps the action routes working without a model: the same 404 body for any id', async () => {
    const without = (body: Record<string, unknown>) => {
      const { requestId: _requestId, ...rest } = body;
      return rest;
    };
    const confirm = await as(ctx, admin)
      .post(`/api/v1/ai/actions/${UNKNOWN_ID}/confirm`)
      .send({})
      .expect(404);
    const malformed = await as(ctx, admin)
      .post('/api/v1/ai/actions/not-an-id/confirm')
      .send({ acknowledgeDestructive: true })
      .expect(404);
    const cancel = await as(ctx, admin).post(`/api/v1/ai/actions/${UNKNOWN_ID}/cancel`).expect(404);
    expect(without(confirm.body)).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Action not found',
    });
    expect(without(malformed.body)).toEqual(without(confirm.body));
    expect(without(cancel.body)).toEqual(without(confirm.body));
  });

  it('requires sign-in', async () => {
    await ctx.http().get('/api/v1/ai/status').expect(401);
    await ctx.http().post('/api/v1/ai/chat').send(chatBody()).expect(401);
  });
});
