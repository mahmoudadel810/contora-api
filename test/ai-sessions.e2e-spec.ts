import { Types } from 'mongoose';
import { AiDataService } from '../src/ai/data/ai-data.service.js';
import { addMember, agentFor, as, signUp, type Actor } from './helpers/actors.js';
import { chat, chatBody, createAiApp, replies, type AiTestApp } from './helpers/ai.js';
import { grantEdit } from './helpers/ai-actions.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { calls, delegate, reply, toolCall } from './helpers/scripted-ai.js';

describe('AI sessions and audit events (e2e)', () => {
  let app: AiTestApp;
  let admin: Actor;
  let member: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    app = await createAiApp();
    admin = await signUp(app.ctx);
    member = await addMember(app.ctx, admin);
    ws = await workspace(app.ctx, admin);
    await grantEdit(app.ctx, admin, member, ws.folderId);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  async function newSession(actor: Actor, message = 'A question'): Promise<string> {
    app.ai.script(replies(1));
    const res = await chat(app.ctx, actor, chatBody({ message }));
    expect(res.status).toBe(200);
    return (res.frames[0] as { sessionId: string }).sessionId;
  }

  it('lists, renames and deletes your own sessions', async () => {
    const actor = await addMember(app.ctx, admin);
    const older = await newSession(actor, 'First chat about invoices');
    const newer = await newSession(actor, `  ${'Long title '.repeat(12)}`);
    const list = await as(app.ctx, actor).get('/api/v1/ai/sessions').expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([newer, older]);
    expect(list.body.items[0].title.length).toBeLessThanOrEqual(80);
    expect(list.body.items[1]).toMatchObject({
      title: 'First chat about invoices',
      messageCount: 2,
      lastMessageAt: expect.any(String),
    });

    const renamed = await as(app.ctx, actor)
      .patch(`/api/v1/ai/sessions/${older}`)
      .send({ title: 'Invoices' })
      .expect(200);
    expect(renamed.body).toMatchObject({ id: older, title: 'Invoices' });
    const invalid = await as(app.ctx, actor)
      .patch(`/api/v1/ai/sessions/${older}`)
      .send({ title: '' })
      .expect(400);
    expect(invalid.body.code).toBe('VALIDATION_FAILED');

    await as(app.ctx, actor).delete(`/api/v1/ai/sessions/${older}`).expect(204);
    await as(app.ctx, actor).get(`/api/v1/ai/sessions/${older}`).expect(404);
    const messages = await app.db
      .collection('ai_messages')
      .countDocuments({ sessionId: new Types.ObjectId(older) });
    expect(messages).toBe(0);
    const deleted = await app.db
      .collection('ai_audit_events')
      .findOne({ sessionId: new Types.ObjectId(older), kind: 'session_deleted' });
    expect(deleted).toMatchObject({ outcome: 'ok', isWrite: false, stopped: false });
  });

  it("answers 404 for another user's or another tenant's session, and never lists it", async () => {
    const sessionId = await newSession(admin, 'Admin only chat');
    const stranger = await signUp(app.ctx);
    for (const actor of [member, stranger]) {
      await as(app.ctx, actor).get(`/api/v1/ai/sessions/${sessionId}`).expect(404);
      await as(app.ctx, actor)
        .patch(`/api/v1/ai/sessions/${sessionId}`)
        .send({ title: 'Mine now' })
        .expect(404);
      await as(app.ctx, actor).delete(`/api/v1/ai/sessions/${sessionId}`).expect(404);
      const list = await as(app.ctx, actor).get('/api/v1/ai/sessions').expect(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).not.toContain(sessionId);
    }
    const still = await as(app.ctx, admin).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    expect(still.body.session.title).toBe('Admin only chat');
  });

  it('re-checks stored cards on read: a record trashed since becomes a notice', async () => {
    const record = await createRecord(app.ctx, admin, ws, { name: 'Soon trashed Ibex 4' });
    app.ai.script(
      [delegate('records', `Read ${record.id}`), reply('Here it is')],
      [calls(toolCall('r1', 'records_get_record', { id: record.id })), reply('Read it')],
    );
    const res = await chat(app.ctx, member, chatBody({ message: 'Show it' }));
    const sessionId = (res.frames[0] as { sessionId: string }).sessionId;
    const before = await as(app.ctx, member).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    expect(before.body.messages[1].blocks).toEqual([
      expect.objectContaining({
        kind: 'record',
        record: expect.objectContaining({ id: record.id }),
      }),
    ]);
    expect(before.body.messages[1].toolTrace).toEqual([
      { domain: 'records', tool: 'records_get_record', ok: true, code: null },
    ]);

    await as(app.ctx, admin).delete(`/api/v1/records/${record.id}`).expect(204);
    const after = await as(app.ctx, member).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    expect(after.body.messages[1].blocks).toEqual([
      {
        kind: 'notice',
        id: expect.any(String),
        tone: 'info',
        text: 'This item is no longer available',
      },
    ]);
    expect(JSON.stringify(after.body.messages[1].blocks)).not.toContain('Soon trashed Ibex 4');
  });

  it('writes text-free audit events with every boolean explicit', async () => {
    const secretText = 'Please summarize the confidential merger plan';
    app.ai.script(
      [delegate('search', 'look for merger plan'), reply('Nothing matched')],
      [calls(toolCall('s1', 'search_list_tags', {})), reply('No tags')],
    );
    const res = await chat(app.ctx, member, chatBody({ message: secretText }));
    const sessionId = new Types.ObjectId((res.frames[0] as { sessionId: string }).sessionId);
    const events = await app.db
      .collection('ai_audit_events')
      .find({ sessionId })
      .sort({ timestamp: 1, _id: 1 })
      .toArray();
    expect(events.map((event) => event.kind)).toEqual([
      'session_created',
      'message',
      'tool_call',
      'tool_call',
      'message',
    ]);
    for (const event of events) {
      for (const flag of ['isWrite', 'confirmed', 'truncated', 'stopped']) {
        expect(typeof event[flag], `${event.kind}.${flag}`).toBe('boolean');
      }
      expect(event.tenantId.toHexString()).toBe(member.tenantId);
      expect(event.userId.toHexString()).toBe(member.userId);
    }
    expect(events[2]).toMatchObject({ tool: 'search_list_tags', domain: 'search', outcome: 'ok' });
    expect(events[3]).toMatchObject({ tool: 'delegate', domain: 'search', outcome: 'ok' });
    expect(events[4]).toMatchObject({
      outcome: 'ok',
      inputTokens: 40,
      outputTokens: 20,
      model: 'scripted-main',
    });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('merger');
    expect(dump).not.toContain('confidential');
  });

  it('records unmetered usage as null tokens, never as zero', async () => {
    app.ai.script([
      {
        stream: new ReadableStream({
          start(controller) {
            for (const part of [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'Hi' },
              { type: 'text-end', id: 't' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: undefined },
                  outputTokens: { total: undefined },
                },
              },
            ]) {
              controller.enqueue(part as never);
            }
            controller.close();
          },
        }),
      },
    ]);
    const res = await chat(app.ctx, member, chatBody({ message: 'Unmetered' }));
    expect(res.frames.at(-1)).toEqual({
      type: 'finish',
      usage: { inputTokens: null, outputTokens: null },
      stopped: false,
    });
    const sessionId = new Types.ObjectId((res.frames[0] as { sessionId: string }).sessionId);
    const answer = await app.db
      .collection('ai_audit_events')
      .findOne({ sessionId, kind: 'message', 'argsSummary.role': 'assistant' });
    expect(answer).toMatchObject({ inputTokens: null, outputTokens: null });
  });

  it('keeps audit events append-only and indexed by session and time', async () => {
    const indexes = await app.db.collection('ai_audit_events').indexes();
    const keys = indexes.map((index) => index.key);
    expect(keys).toContainEqual({ sessionId: 1, timestamp: 1 });
    expect(keys).toContainEqual({ tenantId: 1, timestamp: -1 });
    const usage = await app.db.collection('ai_usage_daily').indexes();
    expect(usage).toContainEqual(
      expect.objectContaining({ key: { tenantId: 1, userId: 1, kind: 1, day: 1 }, unique: true }),
    );
    const model = app.db.model('AiAuditEvent');
    await expect(model.updateMany({}, { $set: { outcome: 'error' } })).rejects.toThrow(
      /append-only/,
    );
    await expect(model.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it("clears a user's sessions, messages and actions but keeps their audit events", async () => {
    const leaver = await addMember(app.ctx, admin);
    const sessionId = await newSession(leaver, 'Before leaving');
    await app.ctx.app.get(AiDataService).clearForUser(leaver.tenantId, leaver.userId);
    const list = await as(app.ctx, leaver).get('/api/v1/ai/sessions').expect(200);
    expect(list.body.total).toBe(0);
    const userId = new Types.ObjectId(leaver.userId);
    expect(await app.db.collection('ai_messages').countDocuments({ userId })).toBe(0);
    expect(
      await app.db
        .collection('ai_audit_events')
        .countDocuments({ sessionId: new Types.ObjectId(sessionId) }),
    ).toBeGreaterThan(0);
  });

  it('removing a member deletes their chats, and a rejoin (same user id) starts with none', async () => {
    const leaver = await addMember(app.ctx, admin);
    await newSession(leaver, 'Before leaving');
    const userId = new Types.ObjectId(leaver.userId);
    expect(await app.db.collection('ai_sessions').countDocuments({ userId })).toBe(1);

    await as(app.ctx, admin).delete(`/api/v1/members/${leaver.userId}`).expect(204);
    expect(await app.db.collection('ai_sessions').countDocuments({ userId })).toBe(0);
    expect(await app.db.collection('ai_messages').countDocuments({ userId })).toBe(0);

    const invited = await as(app.ctx, admin)
      .post('/api/v1/invitations')
      .send({ email: leaver.email, role: 'member' })
      .expect(201);
    const token = new URL(invited.body.acceptUrl as string).searchParams.get('token');
    const accepted = await agentFor(app.ctx)
      .post('/api/v1/invitations/accept')
      .send({ token, displayName: 'Back Again', password: 'Rejoined!Passw0rd' })
      .expect(201);
    expect(accepted.body.user.id).toBe(leaver.userId);
    const list = await as(app.ctx, { token: accepted.body.accessToken as string })
      .get('/api/v1/ai/sessions')
      .expect(200);
    expect(list.body.total).toBe(0);
  });
});
