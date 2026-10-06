import { Types } from 'mongoose';
import { RecordsService } from '../src/records/records.service.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import {
  chat,
  chatBody,
  createAiApp,
  eventually,
  NO_CONTEXT,
  openChat,
  replies,
  searchArgs,
  type AiTestApp,
} from './helpers/ai.js';
import { createRecord, grantRootEdit, workspace, type Workspace } from './helpers/fixtures.js';
import {
  breaksAfterFirstPart,
  calls,
  delegate,
  hangs,
  reply,
  toolCall,
} from './helpers/scripted-ai.js';

describe('AI chat stream (e2e)', () => {
  let app: AiTestApp;
  let admin: Actor;
  let member: Actor;
  let ws: Workspace;
  let invoiceId: string;

  beforeAll(async () => {
    app = await createAiApp();
    admin = await signUp(app.ctx);
    member = await addMember(app.ctx, admin);
    ws = await workspace(app.ctx, admin);
    await grantRootEdit(app.ctx, admin, member);
    invoiceId = (await createRecord(app.ctx, admin, ws, { name: 'Invoice Aurora 7' })).id;
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  const terminals = (frames: Array<{ type: string }>) =>
    frames.filter((frame) => frame.type === 'finish' || frame.type === 'error');

  it('streams session first, then the answer, and ends with exactly one finish frame', async () => {
    app.ai.script([reply('Hello there')]);
    const res = await chat(app.ctx, member, chatBody({ message: 'Hi' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-accel-buffering']).toBe('no');
    const [first, ...rest] = res.frames;
    expect(first).toMatchObject({
      type: 'session',
      sessionId: expect.stringMatching(/^[a-f0-9]{24}$/),
      userMessageId: expect.stringMatching(/^[a-f0-9]{24}$/),
      assistantMessageId: expect.stringMatching(/^[a-f0-9]{24}$/),
    });
    expect(rest.filter((f) => f.type === 'delta').map((f) => (f as { text: string }).text)).toEqual(
      ['Hello there'],
    );
    expect(terminals(res.frames)).toHaveLength(1);
    expect(res.frames.at(-1)).toEqual({
      type: 'finish',
      usage: { inputTokens: 10, outputTokens: 5 },
      stopped: false,
    });

    const sessionId = (first as { sessionId: string }).sessionId;
    const detail = await as(app.ctx, member).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    expect(detail.body.session).toMatchObject({ id: sessionId, title: 'Hi', messageCount: 2 });
    expect(detail.body.messages).toMatchObject([
      { role: 'user', text: 'Hi', status: 'complete', errorCode: null },
      { role: 'assistant', text: 'Hello there', status: 'complete', errorCode: null },
    ]);
    expect(detail.body.actions).toEqual([]);
  });

  it('delegates to a domain whose tool results reach the UI as server-built blocks', async () => {
    app.ai.script(
      [delegate('search', 'Find invoices named Aurora'), reply('You have one invoice.')],
      [
        calls(toolCall('s1', 'search_search_records', searchArgs({ q: 'Aurora' }))),
        reply('Found 1 record: Invoice Aurora 7'),
      ],
    );
    const res = await chat(app.ctx, member, chatBody({ message: 'Which invoices are there?' }));
    const types = res.frames.map((frame) => frame.type);
    expect(types[0]).toBe('session');
    expect(types).toContain('status');
    expect(res.frames).toContainEqual({
      type: 'status',
      origin: 'search',
      label: 'Searching records…',
    });
    const tools = res.frames.filter((frame) => frame.type === 'tool');
    expect(tools).toEqual([
      expect.objectContaining({ tool: 'search_search_records', state: 'running', code: null }),
      expect.objectContaining({ tool: 'search_search_records', state: 'ok', code: null }),
    ]);
    const block = res.frames.find((frame) => frame.type === 'block') as unknown as {
      block: Record<string, unknown>;
    };
    expect(block.block).toMatchObject({
      kind: 'records',
      total: 1,
      truncated: false,
      link: '/search?q=Aurora',
      items: [{ id: invoiceId, name: 'Invoice Aurora 7', link: `/records/${invoiceId}` }],
    });
    expect(block.block).not.toHaveProperty('scope');
    const blockAt = res.frames.findIndex((frame) => frame.type === 'block');
    const okAt = res.frames.findIndex(
      (frame) => frame.type === 'tool' && (frame as { state: string }).state === 'ok',
    );
    expect(blockAt).toBeGreaterThan(-1);
    expect(blockAt).toBeLessThan(okAt);
    expect(terminals(res.frames)).toHaveLength(1);

    const subPrompt = JSON.stringify(app.ai.sub.doStreamCalls[0].prompt);
    expect(subPrompt).toContain('Find invoices named Aurora');
    expect(subPrompt).not.toContain('Which invoices are there?');
    const routerFollowUp = JSON.stringify(app.ai.main.doStreamCalls[1].prompt);
    expect(routerFollowUp).toContain('Found 1 record: Invoice Aurora 7');
  });

  it('answers an unknown or forbidden domain with UNKNOWN_DOMAIN and the valid list', async () => {
    app.ai.script([delegate('admin', 'List the members'), reply('I cannot do that.')]);
    const res = await chat(app.ctx, member, chatBody({ message: 'Who are the members?' }));
    expect(terminals(res.frames)).toEqual([expect.objectContaining({ type: 'finish' })]);
    const followUp = JSON.stringify(app.ai.main.doStreamCalls[1].prompt);
    expect(followUp).toContain('UNKNOWN_DOMAIN');
    expect(followUp).toContain('search');
    const status = await as(app.ctx, member).get('/api/v1/ai/status').expect(200);
    expect(status.body.domains).toEqual(['search', 'records', 'folders', 'schema', 'collab']);
  });

  it('turns a provider failure after the first frame into exactly one error frame', async () => {
    app.ai.script([breaksAfterFirstPart(new Error('upstream down'))]);
    const res = await chat(app.ctx, member, chatBody({ message: 'Break please' }));
    expect(res.status).toBe(200);
    expect(res.frames[0].type).toBe('session');
    expect(terminals(res.frames)).toEqual([
      {
        type: 'error',
        code: 'AI_UNAVAILABLE',
        message: expect.any(String),
        retryable: true,
      },
    ]);
    expect(res.frames.at(-1)?.type).toBe('error');
    const sessionId = (res.frames[0] as { sessionId: string }).sessionId;

    app.ai.script([reply('Back again')]);
    const next = await chat(app.ctx, member, chatBody({ sessionId, message: 'Again' }));
    expect(next.frames.at(-1)?.type).toBe('finish');
    const detail = await as(app.ctx, member).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    expect(detail.body.messages[1]).toMatchObject({
      role: 'assistant',
      status: 'error',
      errorCode: 'AI_UNAVAILABLE',
    });
  });

  it('stops on client abort: the provider call is aborted, the answer stored as stopped, the lease released', async () => {
    const seen: { signal?: AbortSignal } = {};
    app.ai.script([hangs(seen, 'Thinking')]);
    const stream = await openChat(app.ctx, member, chatBody({ message: 'Take your time' }));
    expect(stream.status).toBe(200);
    const frames = await stream.waitForFrames(2);
    const sessionId = (frames[0] as { sessionId: string }).sessionId;
    stream.abort();
    await eventually(() => Promise.resolve(seen.signal?.aborted === true));
    const detail = await eventually(async () => {
      const res = await as(app.ctx, member).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
      return res.body.messages.length === 2 ? res : null;
    });
    expect(detail.body.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Thinking',
      status: 'stopped',
    });
    const stoppedEvent = await eventually(() =>
      app.db
        .collection('ai_audit_events')
        .findOne({ sessionId: new Types.ObjectId(sessionId), kind: 'turn_stopped' }),
    );
    expect(stoppedEvent).toMatchObject({ outcome: 'ok', stopped: true, isWrite: false });
    app.ai.script([reply('Next')]);
    const next = await chat(app.ctx, member, chatBody({ sessionId, message: 'Continue' }));
    expect(next.status).toBe(200);
  });

  it('drops hidden, missing and foreign-tenant context ids without a trace', async () => {
    const other = await signUp(app.ctx);
    const otherWs = await workspace(app.ctx, other, 'Secret folder');
    const foreign = await createRecord(app.ctx, other, otherWs, { name: 'Foreign Zephyr 9' });
    const trashed = await createRecord(app.ctx, admin, ws, { name: 'Trashed Quokka 3' });
    await as(app.ctx, admin).delete(`/api/v1/records/${trashed.id}`).expect(204);
    const missing = 'c'.repeat(24);

    app.ai.script([reply('Nothing to see')]);
    const res = await chat(
      app.ctx,
      member,
      chatBody({
        message: 'What is this?',
        context: {
          ...NO_CONTEXT,
          page: 'record',
          recordId: foreign.id,
          folderId: otherWs.folderId,
          contentTypeId: otherWs.typeId,
          selectedRecordIds: [trashed.id, missing, foreign.id, invoiceId],
        },
      }),
    );
    expect(res.frames.at(-1)?.type).toBe('finish');
    const prompts = app.ai.promptsText();
    for (const secret of [
      foreign.id,
      'Foreign Zephyr 9',
      otherWs.folderId,
      otherWs.typeId,
      'Secret folder',
      trashed.id,
      'Trashed Quokka 3',
      missing,
    ]) {
      expect(res.raw).not.toContain(secret);
      expect(prompts).not.toContain(secret);
    }
    expect(prompts).toContain(invoiceId);
    const sessionId = (res.frames[0] as { sessionId: string }).sessionId;
    const stored = await app.db
      .collection('ai_messages')
      .findOne({ sessionId: new Types.ObjectId(sessionId), role: 'user' });
    expect(stored?.context).toEqual({
      page: 'record',
      recordId: null,
      folderId: null,
      contentTypeId: null,
      search: null,
      selectedRecordIds: [invoiceId],
    });
  });

  it('treats a foreign-tenant id in a tool argument exactly like a missing one', async () => {
    const other = await signUp(app.ctx);
    const otherWs = await workspace(app.ctx, other, 'Elsewhere');
    const foreign = await createRecord(app.ctx, other, otherWs, { name: 'Foreign Yarrow 2' });
    app.ai.script(
      [delegate('records', `Read record ${foreign.id}`), reply('Not found')],
      [calls(toolCall('r1', 'records_get_record', { id: foreign.id })), reply('Not found')],
    );
    const res = await chat(app.ctx, member, chatBody({ message: 'Open it' }));
    expect(res.frames.filter((frame) => frame.type === 'tool').at(-1)).toMatchObject({
      tool: 'records_get_record',
      state: 'error',
      code: 'NOT_FOUND',
    });
    expect(res.raw).not.toContain('Foreign Yarrow 2');
    expect(app.ai.promptsText()).not.toContain('Foreign Yarrow 2');
    const toolResult = JSON.stringify(app.ai.sub.doStreamCalls[1].prompt);
    expect(toolResult).toContain('Record not found');
  });

  it('re-reads the user before each delegation and ends the turn when they were suspended', async () => {
    const victim = await addMember(app.ctx, admin);
    const records = app.ctx.app.get(RecordsService);
    const list = records.list.bind(records);
    const spy = vi.spyOn(records, 'list').mockImplementationOnce(async (...args) => {
      await as(app.ctx, admin).post(`/api/v1/members/${victim.userId}/suspend`).expect(200);
      return list(...args);
    });
    try {
      app.ai.script(
        [
          calls(toolCall('d1', 'delegate', { domain: 'search', task: 'find invoices' })),
          delegate('records', `Read ${invoiceId}`, 'd2'),
          reply('never'),
        ],
        [calls(toolCall('s1', 'search_search_records', searchArgs())), reply('Found some')],
      );
      const res = await chat(app.ctx, victim, chatBody({ message: 'Find and read' }));
      expect(spy).toHaveBeenCalled();
      expect(terminals(res.frames)).toEqual([
        expect.objectContaining({ type: 'error', code: 'AI_SESSION_REVOKED', retryable: false }),
      ]);
      expect(app.ai.sub.doStreamCalls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('regenerates the last answer: the old one is replaced, the same user message kept', async () => {
    app.ai.script([reply('First answer')]);
    const first = await chat(app.ctx, member, chatBody({ message: 'Tell me' }));
    const session = first.frames[0] as { sessionId: string; userMessageId: string };
    app.ai.script([reply('Second answer')]);
    const again = await chat(
      app.ctx,
      member,
      chatBody({ sessionId: session.sessionId, message: 'ignored', mode: 'regenerate' }),
    );
    expect(again.frames[0]).toMatchObject({ userMessageId: session.userMessageId });
    expect(JSON.stringify(app.ai.main.doStreamCalls[0].prompt)).toContain('Tell me');
    const detail = await as(app.ctx, member)
      .get(`/api/v1/ai/sessions/${session.sessionId}`)
      .expect(200);
    expect(
      detail.body.messages.map((message: { role: string; text: string }) => message.text),
    ).toEqual(['Tell me', 'Second answer']);
  });

  it('refuses invalid requests before the stream starts', async () => {
    const tooLong = await chat(app.ctx, member, chatBody({ message: 'x'.repeat(4001) }));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('VALIDATION_FAILED');
    const unknownKey = await chat(app.ctx, member, { ...chatBody(), extra: 1 });
    expect(unknownKey.status).toBe(400);
    const badContext = await chat(
      app.ctx,
      member,
      chatBody({ context: { ...NO_CONTEXT, selectedRecordIds: Array(21).fill(invoiceId) } }),
    );
    expect(badContext.status).toBe(400);
    const nothing = await chat(app.ctx, member, chatBody({ mode: 'regenerate' }));
    expect(nothing.status).toBe(409);
    expect(nothing.body.code).toBe('AI_NOTHING_TO_REGENERATE');
  });

  it("answers 404 for another user's or another tenant's session id", async () => {
    app.ai.script(replies(1));
    const own = await chat(app.ctx, admin, chatBody({ message: 'Mine' }));
    const sessionId = (own.frames[0] as { sessionId: string }).sessionId;
    const other = await signUp(app.ctx);
    for (const actor of [member, other]) {
      const res = await chat(app.ctx, actor, chatBody({ sessionId, message: 'Hijack' }));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
  });
});
