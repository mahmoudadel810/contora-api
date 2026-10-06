import { Types } from 'mongoose';
import { signUp, type Actor } from './helpers/actors.js';
import { chat, chatBody, createAiApp, type AiTestApp } from './helpers/ai.js';
import { hangs, stalls } from './helpers/scripted-ai.js';

describe('AI chat timeout (e2e)', () => {
  let app: AiTestApp;
  let admin: Actor;

  beforeAll(async () => {
    app = await createAiApp({ AI_REQUEST_TIMEOUT_MS: '400' });
    admin = await signUp(app.ctx);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  it('ends a turn that outlives AI_REQUEST_TIMEOUT_MS with one AI_TIMEOUT error frame', async () => {
    const seen: { signal?: AbortSignal } = {};
    app.ai.script([hangs(seen, 'Still thinking')]);
    const res = await chat(app.ctx, admin, chatBody({ message: 'Slow question' }));
    expect(res.status).toBe(200);
    expect(res.frames[0].type).toBe('session');
    const terminals = res.frames.filter((f) => f.type === 'finish' || f.type === 'error');
    expect(terminals).toEqual([
      { type: 'error', code: 'AI_TIMEOUT', message: expect.any(String), retryable: true },
    ]);
    expect(res.frames.at(-1)?.type).toBe('error');
    expect(seen.signal?.aborted).toBe(true);

    const sessionId = new Types.ObjectId((res.frames[0] as { sessionId: string }).sessionId);
    const session = await app.db.collection('ai_sessions').findOne({ _id: sessionId });
    expect(session).toMatchObject({ turnId: null, turnLeaseUntil: null, messageCount: 2 });
    const answer = await app.db.collection('ai_messages').findOne({ sessionId, role: 'assistant' });
    expect(answer).toMatchObject({ status: 'error', errorCode: 'AI_TIMEOUT', stopped: false });
    const failed = await app.db
      .collection('ai_audit_events')
      .findOne({ sessionId, kind: 'turn_failed' });
    expect(failed).toMatchObject({ outcome: 'error', errorCode: 'AI_TIMEOUT' });
  });

  it('still ends a turn whose provider stream ignores the abort signal', async () => {
    const seen: { signal?: AbortSignal } = {};
    app.ai.script([stalls(seen)]);
    const started = Date.now();
    const res = await chat(app.ctx, admin, chatBody({ message: 'Stalled question' }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.frames.at(-1)).toMatchObject({ type: 'error', code: 'AI_TIMEOUT', retryable: true });
    expect(res.frames.filter((f) => f.type === 'finish' || f.type === 'error')).toHaveLength(1);
    expect(seen.signal?.aborted).toBe(true);
  });
});
