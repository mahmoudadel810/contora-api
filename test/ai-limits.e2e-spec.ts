import { Types } from 'mongoose';
import { addMember, signUp, type Actor } from './helpers/actors.js';
import {
  chat,
  chatBody,
  createAiApp,
  eventually,
  openChat,
  replies,
  type AiTestApp,
} from './helpers/ai.js';
import { calls, delegate, hangs, reply, toolCall } from './helpers/scripted-ai.js';

const LIMITS = {
  AI_USER_RATE_LIMIT: '3',
  AI_TENANT_DAILY_TURN_LIMIT: '4',
  AI_USER_DAILY_TURN_LIMIT: '2',
  AI_MAX_STEPS: '2',
  AI_MAX_OUTPUT_TOKENS: '99999',
};

describe('AI chat limits (e2e)', () => {
  let app: AiTestApp;

  beforeAll(async () => {
    app = await createAiApp(LIMITS);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  async function tenantWith(members: number): Promise<{ admin: Actor; members: Actor[] }> {
    const admin = await signUp(app.ctx);
    const list: Actor[] = [];
    for (let i = 0; i < members; i += 1) list.push(await addMember(app.ctx, admin));
    return { admin, members: list };
  }

  const turnsOf = async (tenantId: string, userId: string | null) =>
    (
      await app.db.collection('ai_usage_daily').findOne({
        tenantId: new Types.ObjectId(tenantId),
        userId: userId ? new Types.ObjectId(userId) : null,
        kind: 'chat',
      })
    )?.turns;

  it('limits turns per user and minute with 429 AI_RATE_LIMITED and retryAfterSeconds', async () => {
    const { admin } = await tenantWith(0);
    app.ai.script(replies(2));
    expect((await chat(app.ctx, admin)).status).toBe(200);
    expect((await chat(app.ctx, admin)).status).toBe(200);
    const third = await chat(app.ctx, admin);
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({
      code: 'AI_USER_LIMIT',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    const fourth = await chat(app.ctx, admin);
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('AI_RATE_LIMITED');
    expect(
      (fourth.body.details as { retryAfterSeconds: number }).retryAfterSeconds,
    ).toBeGreaterThan(0);
  });

  it('never passes the tenant daily cap when turns race at the threshold', async () => {
    const { admin, members } = await tenantWith(5);
    app.ai.script(replies(6));
    const results = await Promise.all([admin, ...members].map((actor) => chat(app.ctx, actor)));
    const statuses = results.map((result) => result.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
    for (const refused of results.filter((result) => result.status === 429)) {
      expect(refused.body).toMatchObject({
        code: 'AI_TENANT_LIMIT',
        details: { retryAfterSeconds: expect.any(Number) },
      });
    }
    expect(await turnsOf(admin.tenantId, null)).toBe(4);
    const sessions = await app.db
      .collection('ai_sessions')
      .countDocuments({ tenantId: new Types.ObjectId(admin.tenantId) });
    expect(sessions).toBe(4);
  });

  it("never passes a user's daily cap under concurrent turns, and gives the tenant count back", async () => {
    const { admin } = await tenantWith(0);
    app.ai.script(replies(3));
    expect((await chat(app.ctx, admin)).status).toBe(200);
    const results = await Promise.all([chat(app.ctx, admin), chat(app.ctx, admin)]);
    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 429]);
    expect(results.find((result) => result.status === 429)?.body.code).toBe('AI_USER_LIMIT');
    expect(await turnsOf(admin.tenantId, admin.userId)).toBe(2);
    expect(await turnsOf(admin.tenantId, null)).toBe(2);
  });

  it('holds one turn per session (409 AI_TURN_IN_PROGRESS) and releases it after', async () => {
    const { admin } = await tenantWith(0);
    const seen: { signal?: AbortSignal } = {};
    app.ai.script([hangs(seen)]);
    const first = await openChat(app.ctx, admin, chatBody({ message: 'Slow one' }));
    const [session] = await first.waitForFrames(1);
    const sessionId = (session as { sessionId: string }).sessionId;
    const second = await chat(app.ctx, admin, chatBody({ sessionId, message: 'Me too' }));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('AI_TURN_IN_PROGRESS');
    first.abort();
    await eventually(async () => {
      const row = await app.db
        .collection('ai_sessions')
        .findOne({ _id: new Types.ObjectId(sessionId) });
      return row?.turnId === null && row.turnLeaseUntil === null;
    });
  });

  it('allows at most two turns of one user in flight across sessions', async () => {
    const { admin } = await tenantWith(0);
    const a: { signal?: AbortSignal } = {};
    const b: { signal?: AbortSignal } = {};
    app.ai.script([hangs(a), hangs(b)]);
    const one = await openChat(app.ctx, admin, chatBody({ message: 'One' }));
    await one.waitForFrames(1);
    const two = await openChat(app.ctx, admin, chatBody({ message: 'Two' }));
    await two.waitForFrames(1);
    const three = await chat(app.ctx, admin, chatBody({ message: 'Three' }));
    expect(three.status).toBe(409);
    expect(three.body.code).toBe('AI_TURN_IN_PROGRESS');
    const sessions = await app.db
      .collection('ai_sessions')
      .countDocuments({ userId: new Types.ObjectId(admin.userId) });
    expect(sessions).toBe(2);
    one.abort();
    two.abort();
    await eventually(() =>
      Promise.resolve(a.signal?.aborted === true && b.signal?.aborted === true),
    );
  });

  it('refuses a full session with 409 AI_SESSION_FULL', async () => {
    const { admin } = await tenantWith(0);
    app.ai.script(replies(1));
    const first = await chat(app.ctx, admin);
    const sessionId = (first.frames[0] as { sessionId: string }).sessionId;
    await app.db
      .collection('ai_sessions')
      .updateOne({ _id: new Types.ObjectId(sessionId) }, { $set: { messageCount: 399 } });
    const full = await chat(app.ctx, admin, chatBody({ sessionId }));
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('AI_SESSION_FULL');
  });

  it('stops the router after AI_MAX_STEPS steps and clamps the output tokens', async () => {
    const { admin } = await tenantWith(0);
    app.ai.script(
      [delegate('search', 'one', 'd1'), delegate('search', 'two', 'd2'), reply('never')],
      [reply('first'), reply('second')],
    );
    const res = await chat(app.ctx, admin, chatBody({ message: 'Keep going' }));
    expect(res.frames.at(-1)?.type).toBe('finish');
    expect(app.ai.main.doStreamCalls).toHaveLength(2);
    expect(app.ai.main.doStreamCalls[0].maxOutputTokens).toBe(16000);
    expect(app.ai.sub.doStreamCalls[0].maxOutputTokens).toBe(16000);
  });

  it('allows at most four delegations per turn (TURN_BUDGET_EXHAUSTED)', async () => {
    const { admin } = await tenantWith(0);
    app.ai.script(
      [
        calls(
          ...[1, 2, 3, 4, 5].map((n) =>
            toolCall(`d${n}`, 'delegate', { domain: 'search', task: `task ${n}` }),
          ),
        ),
        reply('Done'),
      ],
      replies(4, 'sub answer'),
    );
    const res = await chat(app.ctx, admin, chatBody({ message: 'Many things' }));
    expect(res.frames.at(-1)?.type).toBe('finish');
    expect(app.ai.sub.doStreamCalls).toHaveLength(4);
    expect(JSON.stringify(app.ai.main.doStreamCalls[1].prompt)).toContain('TURN_BUDGET_EXHAUSTED');
  });
});
