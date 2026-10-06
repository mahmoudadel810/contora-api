import { Types } from 'mongoose';
import { AiUsageRepository } from '../src/ai/data/ai-data.repositories.js';
import { AccessService } from '../src/access/access.service.js';
import { RecordsService } from '../src/records/records.service.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import {
  chat,
  chatBody,
  createAiApp,
  baseUrlOf,
  eventually,
  openChat,
  searchArgs,
  type AiTestApp,
} from './helpers/ai.js';
import { createRecord, grantRootEdit, workspace, type Workspace } from './helpers/fixtures.js';
import { calls, delegate, hangs, reply, toolCall } from './helpers/scripted-ai.js';

describe('AI chat edge cases (e2e)', () => {
  let app: AiTestApp;
  let admin: Actor;
  let member: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    app = await createAiApp();
    admin = await signUp(app.ctx);
    member = await addMember(app.ctx, admin);
    ws = await workspace(app.ctx, admin);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  const sessionRow = (id: string) =>
    app.db.collection('ai_sessions').findOne({ _id: new Types.ObjectId(id) });

  it('an empty search gives a notice block and the model is told total 0', async () => {
    app.ai.script(
      [delegate('search', 'Find the nonexistent'), reply('Nothing was found')],
      [
        calls(toolCall('s1', 'search_search_records', searchArgs({ q: 'no-such-thing-zq9' }))),
        reply('Nothing matched'),
      ],
    );
    const res = await chat(app.ctx, admin, chatBody({ message: 'Find no-such-thing-zq9' }));
    const blocks = res.frames.filter((frame) => frame.type === 'block');
    expect(blocks).toEqual([
      {
        type: 'block',
        block: {
          kind: 'notice',
          id: expect.any(String),
          tone: 'info',
          text: 'Nothing matched this search.',
        },
      },
    ]);
    const toolResult = JSON.stringify(app.ai.sub.doStreamCalls[1].prompt);
    expect(toolResult).toMatch(/\\?"total\\?":0/);
  });

  it('same-session lease race: two concurrent sends give one 200 and one 409', async () => {
    app.ai.script([reply('First')]);
    const first = await chat(app.ctx, member, chatBody({ message: 'Open a session' }));
    const sessionId = (first.frames[0] as { sessionId: string }).sessionId;
    const seen: { signal?: AbortSignal } = {};
    await baseUrlOf(app.ctx);
    app.ai.script([hangs(seen)]);
    const [a, b] = await Promise.all([
      openChat(app.ctx, member, chatBody({ sessionId, message: 'One' })),
      openChat(app.ctx, member, chatBody({ sessionId, message: 'Two' })),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    winner.abort();
    await eventually(async () => {
      const row = await sessionRow(sessionId);
      return row?.turnId === null;
    });
  });

  it('a late settle never releases a newer turn\x27s lease (turnId)', async () => {
    app.ai.script([reply('Start')]);
    const start = await chat(app.ctx, member, chatBody({ message: 'Lease owner' }));
    const sessionId = (start.frames[0] as { sessionId: string }).sessionId;
    const seenA: { signal?: AbortSignal } = {};
    const seenB: { signal?: AbortSignal } = {};
    app.ai.script([hangs(seenA), hangs(seenB)]);
    const turnA = await openChat(app.ctx, member, chatBody({ sessionId, message: 'Turn A' }));
    await turnA.waitForFrames(1);
    const leaseA = (await sessionRow(sessionId))?.turnId as string;
    await app.db
      .collection('ai_sessions')
      .updateOne(
        { _id: new Types.ObjectId(sessionId) },
        { $set: { turnLeaseUntil: new Date(Date.now() - 1000) } },
      );
    const turnB = await openChat(app.ctx, member, chatBody({ sessionId, message: 'Turn B' }));
    expect(turnB.status).toBe(200);
    await turnB.waitForFrames(1);
    const leaseB = (await sessionRow(sessionId))?.turnId as string;
    expect(leaseB).not.toBe(leaseA);

    turnA.abort();
    await eventually(async () => {
      const stopped = await app.db
        .collection('ai_messages')
        .countDocuments({ sessionId: new Types.ObjectId(sessionId), status: 'stopped' });
      return stopped >= 1;
    });
    expect((await sessionRow(sessionId))?.turnId).toBe(leaseB);

    turnB.abort();
    await eventually(async () => (await sessionRow(sessionId))?.turnId === null);
  });

  it('a token cut-off between two delegations ends the turn with AI_SESSION_REVOKED', async () => {
    const victim = await addMember(app.ctx, admin);
    const records = app.ctx.app.get(RecordsService);
    const list = records.list.bind(records);
    const spy = vi.spyOn(records, 'list').mockImplementationOnce(async (...args) => {
      await app.db
        .collection('users')
        .updateOne(
          { _id: new Types.ObjectId(victim.userId) },
          { $set: { tokensValidAfter: new Date(Date.now() + 1000) } },
        );
      return list(...args);
    });
    try {
      app.ai.script(
        [
          calls(toolCall('d1', 'delegate', { domain: 'search', task: 'find invoices' })),
          delegate('folders', 'Show the tree', 'd2'),
          reply('never'),
        ],
        [calls(toolCall('s1', 'search_search_records', searchArgs())), reply('Found some')],
      );
      const res = await chat(app.ctx, victim, chatBody({ message: 'Find, then browse' }));
      expect(spy).toHaveBeenCalled();
      expect(
        res.frames.filter((frame) => frame.type === 'error' || frame.type === 'finish'),
      ).toEqual([
        expect.objectContaining({ type: 'error', code: 'AI_SESSION_REVOKED', retryable: false }),
      ]);
      expect(app.ai.sub.doStreamCalls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('re-checks at most 200 records and 200 folders per session read; the rest count as hidden', async () => {
    app.ai.script([reply('Stored')]);
    const res = await chat(app.ctx, admin, chatBody({ message: 'A big history' }));
    const sessionId = (res.frames[0] as { sessionId: string }).sessionId;
    const real = await createRecord(app.ctx, admin, ws, { name: 'Past the bound Okapi 9' });
    const fakeIds = (count: number) =>
      Array.from({ length: count }, () => new Types.ObjectId().toHexString());
    const card = (id: string, name: string) => ({
      id,
      name,
      contentTypeName: null,
      folderName: null,
      tags: [],
      updatedAt: new Date().toISOString(),
      fileName: null,
      link: `/records/${id}`,
    });
    await app.db.collection('ai_messages').insertOne({
      tenantId: new Types.ObjectId(admin.tenantId),
      sessionId: new Types.ObjectId(sessionId),
      userId: new Types.ObjectId(admin.userId),
      role: 'assistant',
      text: 'Lots',
      blocks: [
        {
          kind: 'records',
          id: 'big-1',
          title: 'Many',
          total: 251,
          truncated: false,
          link: null,
          items: [
            ...fakeIds(250).map((id) => card(id, 'Ghost')),
            card(real.id, 'Past the bound Okapi 9'),
          ],
        },
        {
          kind: 'folders',
          id: 'big-2',
          items: fakeIds(250).map((id) => ({
            id,
            name: 'Ghost folder',
            path: 'x',
            link: `/repository/${id}`,
          })),
        },
      ],
      toolTrace: [],
      status: 'complete',
      errorCode: null,
      stopped: false,
      regenerated: false,
      kind: 'answer',
      context: null,
      createdAt: new Date(),
    });
    const access = app.ctx.app.get(AccessService);
    const recordsGet = vi.spyOn(access, 'requireRecord');
    const foldersGet = vi.spyOn(access, 'requireFolder');
    try {
      const detail = await as(app.ctx, admin).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
      expect(recordsGet).toHaveBeenCalledTimes(200);
      expect(foldersGet).toHaveBeenCalledTimes(200);
      const last = detail.body.messages.at(-1) as { blocks: unknown[] };
      expect(last.blocks).toEqual([
        expect.objectContaining({ kind: 'notice', text: 'This item is no longer available' }),
        expect.objectContaining({ kind: 'notice', text: 'This item is no longer available' }),
      ]);
      expect(JSON.stringify(detail.body)).not.toContain('Past the bound Okapi 9');
    } finally {
      recordsGet.mockRestore();
      foldersGet.mockRestore();
    }
  });

  it("drops a hidden folder's name from stored cards and hides a block titled with it", async () => {
    const folder = (
      await as(app.ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Soon gone Tapir', parentId: ws.folderId })
        .expect(201)
    ).body.id as string;
    const moved = await createRecord(
      app.ctx,
      admin,
      { ...ws, folderId: folder },
      { name: 'Survivor Heron' },
    );
    app.ai.script(
      [
        delegate('records', `Read ${moved.id}`, 'd1'),
        delegate('folders', `Open ${folder}`, 'd2'),
        reply('Done'),
      ],
      [
        calls(toolCall('r1', 'records_get_record', { id: moved.id })),
        reply('Read'),
        calls(toolCall('f1', 'folders_get_folder', { id: folder })),
        reply('Opened'),
      ],
    );
    const res = await chat(app.ctx, admin, chatBody({ message: 'Read and open' }));
    const sessionId = (res.frames[0] as { sessionId: string }).sessionId;
    await as(app.ctx, admin)
      .post(`/api/v1/records/${moved.id}/move`)
      .send({ folderId: ws.folderId })
      .expect(200);
    await as(app.ctx, admin).delete(`/api/v1/folders/${folder}`).expect(204);
    const detail = await as(app.ctx, admin).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    const blocks = detail.body.messages.at(-1).blocks as Array<Record<string, unknown>>;
    const record = blocks.find((block) => block.kind === 'record') as {
      record: Record<string, unknown>;
    };
    expect(record.record).toMatchObject({ id: moved.id, folderName: null });
    expect(JSON.stringify(blocks)).not.toContain('Soon gone Tapir');
  });

  it('shows a stored tag table again only to admins (derived counts)', async () => {
    await grantRootEdit(app.ctx, admin, member);
    await createRecord(app.ctx, admin, ws, { name: 'Tagged for the cloud' });
    const script = () =>
      app.ai.script(
        [delegate('search', 'List tags'), reply('Tags')],
        [calls(toolCall('t1', 'search_list_tags', {})), reply('Listed')],
      );
    await as(app.ctx, admin)
      .put(
        `/api/v1/records/${(await createRecord(app.ctx, admin, ws, { name: 'With tag' })).id}/tags`,
      )
      .send({ tags: ['cloudy'] })
      .expect(200);
    script();
    const mine = await chat(app.ctx, member, chatBody({ message: 'Which tags?' }));
    const sessionId = (mine.frames[0] as { sessionId: string }).sessionId;
    expect(mine.frames.some((frame) => frame.type === 'block')).toBe(true);
    const detail = await as(app.ctx, member).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    expect(detail.body.messages.at(-1).blocks).toEqual([
      expect.objectContaining({ kind: 'notice', text: 'This item is no longer available' }),
    ]);
  });
});

describe('AI daily cap race at the threshold (e2e)', () => {
  let app: AiTestApp;

  beforeAll(async () => {
    app = await createAiApp({ AI_TENANT_DAILY_TURN_LIMIT: '1' });
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  it('lets exactly one of two racing turns through the tenant cap (vi.spyOn on countBelow)', async () => {
    const admin = await signUp(app.ctx);
    const member = await addMember(app.ctx, admin);
    const usage = app.ctx.app.get(AiUsageRepository);
    const countBelow = usage.countBelow.bind(usage);
    let raced: Awaited<ReturnType<typeof chat>> | null = null;
    const spy = vi.spyOn(usage, 'countBelow').mockImplementationOnce(async (...args) => {
      app.ai.script([reply('The other turn')]);
      raced = await chat(app.ctx, member, chatBody({ message: 'Me first' }));
      return countBelow(...args);
    });
    try {
      const res = await chat(app.ctx, admin, chatBody({ message: 'Racing' }));
      expect(spy).toHaveBeenCalled();
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({
        code: 'AI_TENANT_LIMIT',
        details: { retryAfterSeconds: expect.any(Number) },
      });
      expect((raced as unknown as { status: number }).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const tenantRow = await app.db
      .collection('ai_usage_daily')
      .findOne({ tenantId: new Types.ObjectId(admin.tenantId), userId: null, kind: 'chat' });
    expect(tenantRow?.turns).toBe(1);
  });
});
