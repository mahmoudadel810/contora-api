import { Logger } from '@nestjs/common';
import { APICallError } from 'ai';
import { Types } from 'mongoose';
import { signUp, type Actor } from './helpers/actors.js';
import { chat, chatBody, createAiApp, eventually, type AiTestApp } from './helpers/ai.js';
import { delegate, fails } from './helpers/scripted-ai.js';

const KEY = 'sk-FAKE-KEY-4c1d2e3f5a6b7c8d9e0f1a2b3c4d5e6f';
const USER_TEXT = 'Tell me about the Zanzibar quokka ledger 42';

function leakyError(): APICallError {
  return new APICallError({
    message: `Unauthorized: key ${KEY} rejected for "${USER_TEXT}"`,
    url: `https://example.openai.azure.com/openai/deployments/x?api-key=${KEY}`,
    requestBodyValues: { messages: [{ role: 'user', content: USER_TEXT }], apiKey: KEY },
    statusCode: 401,
    responseHeaders: { 'api-key': KEY },
    responseBody: JSON.stringify({ error: { message: `bad key ${KEY}`, prompt: USER_TEXT } }),
    isRetryable: false,
  });
}

describe('AI provider errors are redacted everywhere (e2e)', () => {
  let app: AiTestApp;
  let member: Actor;
  const captured: string[] = [];
  const restores: Array<() => void> = [];

  const serialize = (arg: unknown): string =>
    typeof arg === 'string'
      ? arg
      : JSON.stringify(arg, (_key, value: unknown) =>
          value instanceof Error
            ? {
                ...Object.fromEntries(Object.entries(value)),
                name: value.name,
                message: value.message,
                stack: value.stack,
              }
            : value,
        );
  const capture =
    (label: string) =>
    (...args: unknown[]) => {
      captured.push(`${label} ${args.map(serialize).join(' ')}`);
    };

  beforeAll(async () => {
    app = await createAiApp();
    member = await signUp(app.ctx);
  });

  beforeEach(() => {
    captured.length = 0;
    for (const method of ['error', 'warn', 'log', 'info', 'debug'] as const) {
      const spy = vi.spyOn(console, method).mockImplementation(capture(`console.${method}`));
      restores.push(() => spy.mockRestore());
    }
    for (const method of ['error', 'warn', 'log', 'debug', 'verbose', 'fatal'] as const) {
      const spy = vi
        .spyOn(Logger.prototype, method)
        .mockImplementation(capture(`Logger.${method}`));
      restores.push(() => spy.mockRestore());
    }
    const write = process.stderr.write.bind(process.stderr);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      captured.push(`stderr ${String(chunk)}`);
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write);
    restores.push(() => stderr.mockRestore());
  });

  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  function assertNothingLeaked(raw: string) {
    const logs = captured.join('\n');
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain(USER_TEXT);
    expect(logs).not.toContain('example.openai.azure.com');
    expect(raw).not.toContain(KEY);
  }

  it('router: a provider refusal before the stream is one call, one AI_UNAVAILABLE frame, no leak', async () => {
    app.ai.script([fails(leakyError())]);
    const res = await chat(app.ctx, member, chatBody({ message: USER_TEXT }));
    expect(res.status).toBe(200);
    expect(app.ai.main.doStreamCalls).toHaveLength(1);
    const terminal = res.frames.filter(
      (frame) => frame.type === 'finish' || frame.type === 'error',
    );
    expect(terminal).toEqual([
      { type: 'error', code: 'AI_UNAVAILABLE', message: expect.any(String), retryable: true },
    ]);
    assertNothingLeaked(res.raw);
    expect(captured.join('\n')).toMatch(/AI_APICallError|APICallError/);
    const sessionId = (res.frames[0] as { sessionId: string }).sessionId;
    const events = await app.db
      .collection('ai_audit_events')
      .find({ sessionId: new Types.ObjectId(sessionId) })
      .toArray();
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(USER_TEXT);
  });

  it('delegation: a subagent provider failure ends the turn once, releases the lease, audits error', async () => {
    app.ai.script([delegate('records', `Look into: ${USER_TEXT}`)], [fails(leakyError())]);
    const res = await chat(app.ctx, member, chatBody({ message: USER_TEXT }));
    expect(res.status).toBe(200);
    expect(app.ai.sub.doStreamCalls).toHaveLength(1);
    const terminal = res.frames.filter(
      (frame) => frame.type === 'finish' || frame.type === 'error',
    );
    expect(terminal).toEqual([
      { type: 'error', code: 'AI_UNAVAILABLE', message: expect.any(String), retryable: true },
    ]);
    assertNothingLeaked(res.raw);
    const sessionId = (res.frames[0] as { sessionId: string }).sessionId;
    await eventually(async () => {
      const row = await app.db
        .collection('ai_sessions')
        .findOne({ _id: new Types.ObjectId(sessionId) });
      return row?.turnId === null && row.turnLeaseUntil === null;
    });
    const delegation = await app.db.collection('ai_audit_events').findOne({
      sessionId: new Types.ObjectId(sessionId),
      kind: 'tool_call',
      tool: 'delegate',
    });
    expect(delegation).toMatchObject({
      outcome: 'error',
      errorCode: 'AI_UNAVAILABLE',
      domain: 'records',
    });
  });
});
