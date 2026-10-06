import { Types } from 'mongoose';
import { DOMAINS } from '../src/ai/tools/domains.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { chat, chatBody, createAiApp, type AiTestApp } from './helpers/ai.js';
import { confirm, grantEdit, propose } from './helpers/ai-actions.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { calls, delegate, reply, toolCall } from './helpers/scripted-ai.js';

describe('AI collab and admin domains (e2e)', () => {
  let app: AiTestApp;
  let admin: Actor;
  let member: Actor;
  let peer: Actor;
  let ws: Workspace;

  const newRecord = async (name: string) => (await createRecord(app.ctx, admin, ws, { name })).id;
  const comment = async (actor: Actor, recordId: string, body: string) =>
    (
      await as(app.ctx, actor)
        .post(`/api/v1/records/${recordId}/comments`)
        .send({ body })
        .expect(201)
    ).body.id as string;

  beforeAll(async () => {
    app = await createAiApp();
    admin = await signUp(app.ctx);
    member = await addMember(app.ctx, admin);
    peer = await addMember(app.ctx, admin);
    ws = await workspace(app.ctx, admin);
    await grantEdit(app.ctx, admin, member, ws.folderId);
    await grantEdit(app.ctx, admin, peer, ws.folderId);
  });

  afterAll(async () => {
    await app.ctx.stop();
  });

  it('gives members the collab domain but no admin domain; admins get both', async () => {
    const forMember = await as(app.ctx, member).get('/api/v1/ai/status').expect(200);
    expect(forMember.body.domains).toEqual(['search', 'records', 'folders', 'schema', 'collab']);
    const forAdmin = await as(app.ctx, admin).get('/api/v1/ai/status').expect(200);
    expect(forAdmin.body.domains).toContain('admin');
    app.ai.script([delegate('admin', 'List the members'), reply('I cannot')]);
    const res = await chat(app.ctx, member, chatBody({ message: 'Who are the members?' }));
    expect(JSON.stringify(app.ai.main.doStreamCalls[1].prompt)).toContain('UNKNOWN_DOMAIN');
    expect(res.frames.at(-1)?.type).toBe('finish');
  });

  it('hands every subagent at most 14 tools, and a member no schema or admin write', async () => {
    for (const domain of DOMAINS) expect(domain.tools.length, domain.name).toBeLessThanOrEqual(14);
    for (const [actor, domain] of [
      [member, 'schema'],
      [admin, 'admin'],
      [admin, 'collab'],
      [admin, 'records'],
    ] as const) {
      app.ai.script([delegate(domain, 'Look'), reply('Done')], [reply('Nothing to do')]);
      await chat(app.ctx, actor, chatBody({ message: 'Look' }));
      const offered = (app.ai.sub.doStreamCalls[0].tools ?? []).map((tool) => tool.name);
      expect(offered.length, domain).toBeLessThanOrEqual(14);
      if (actor === member)
        expect(offered.filter((name) => name.includes('_propose_'))).toEqual([]);
    }
  });

  it("refuses to delete someone else's comment, even for an admin, and deletes your own", async () => {
    const id = await newRecord('Commented');
    const theirs = await comment(peer, id, 'Peer wrote this');
    const mine = await comment(member, id, 'I wrote this');
    for (const actor of [member, admin]) {
      const refused = await propose(app, actor, 'collab', [
        { tool: 'collab_propose_delete_comment', args: { recordId: id, commentId: theirs } },
      ]);
      expect(refused.actionIds).toEqual([]);
      expect(refused.toolFrames.at(-1)).toMatchObject({ state: 'error', code: 'COMMENT_NOT_OWN' });
    }
    const own = await propose(
      app,
      member,
      'collab',
      [{ tool: 'collab_propose_delete_comment', args: { recordId: id, commentId: mine } }],
      { message: `Delete my comment on ${id}` },
    );
    expect(own.confirmBlocks[0]).toMatchObject({ destructive: true, confirmLabel: 'delete' });
    expect((await confirm(app.ctx, member, own.actionIds[0]).expect(409)).body.code).toBe(
      'CONFIRMATION_REQUIRED',
    );
    await confirm(app.ctx, member, own.actionIds[0], { acknowledgeDestructive: true }).expect(200);
    const left = await as(app.ctx, admin).get(`/api/v1/records/${id}/comments`).expect(200);
    expect((left.body as Array<{ id: string }>).map((c) => c.id)).toEqual([theirs]);
  });

  it('comments, relates, unrelates and favorites through confirms', async () => {
    const a = await newRecord('Relating A');
    const b = await newRecord('Relating B');
    const commented = await propose(
      app,
      member,
      'collab',
      [{ tool: 'collab_propose_comment', args: { recordId: a, body: 'Checked by the assistant' } }],
      { message: `Comment on ${a}` },
    );
    await confirm(app.ctx, member, commented.actionIds[0]).expect(200);
    const comments = await as(app.ctx, admin).get(`/api/v1/records/${a}/comments`).expect(200);
    expect(comments.body).toEqual([
      expect.objectContaining({
        body: 'Checked by the assistant',
        author: expect.objectContaining({ id: member.userId }),
      }),
    ]);

    const related = await propose(
      app,
      member,
      'collab',
      [
        {
          tool: 'collab_propose_relation',
          args: { recordId: a, otherId: b, kind: 'references', direction: null },
        },
      ],
      { message: `Relate ${a} to ${b}` },
    );
    expect(related.confirmBlocks[0]).toMatchObject({ reviewEach: true, confirmLabel: 'create' });
    await confirm(app.ctx, member, related.actionIds[0]).expect(200);
    const relations = await as(app.ctx, admin).get(`/api/v1/records/${a}/relations`).expect(200);
    expect(relations.body.items).toEqual([expect.objectContaining({ kind: 'references' })]);

    const removed = await propose(
      app,
      member,
      'collab',
      [
        {
          tool: 'collab_propose_remove_relation',
          args: { recordId: a, relationId: relations.body.items[0].id as string },
        },
      ],
      { message: `Unrelate ${a} and ${b}` },
    );
    await confirm(app.ctx, member, removed.actionIds[0], { acknowledgeDestructive: true }).expect(
      200,
    );
    expect(
      (await as(app.ctx, admin).get(`/api/v1/records/${a}/relations`).expect(200)).body.items,
    ).toEqual([]);

    const favorite = await propose(
      app,
      member,
      'collab',
      [{ tool: 'collab_propose_favorite', args: { recordId: a, favorite: true } }],
      { message: `Favorite ${a}` },
    );
    await confirm(app.ctx, member, favorite.actionIds[0]).expect(200);
    const favorites = await as(app.ctx, member).get('/api/v1/me/favorites').expect(200);
    expect(JSON.stringify(favorites.body)).toContain(a);
    const audit = await as(app.ctx, admin)
      .get(`/api/v1/audit?action=AI_ACTION_CONFIRMED&resourceId=${a}`)
      .expect(200);
    const tools = (audit.body.items as Array<{ context: { tool: string } }>).map(
      (entry) => entry.context.tool,
    );
    expect(tools).not.toContain('collab_propose_favorite');
    expect(tools).toContain('collab_propose_comment');
  });

  it('keeps every email away from the model in the admin domain', async () => {
    app.ai.script(
      [delegate('admin', 'List members and the latest audit entries'), reply('Done')],
      [
        calls(toolCall('a1', 'admin_list_members', {})),
        calls(
          toolCall('a2', 'admin_search_audit', {
            action: null,
            actorId: null,
            resourceType: null,
            resourceId: null,
            from: null,
            to: null,
            page: null,
          }),
        ),
        calls(toolCall('a3', 'admin_get_overview', {})),
        reply('Listed'),
      ],
    );
    const res = await chat(app.ctx, admin, chatBody({ message: 'Who is here?' }));
    expect(res.frames.at(-1)?.type).toBe('finish');
    const prompts = app.ai.promptsText();
    for (const actor of [admin, member, peer]) expect(prompts).not.toContain(actor.email);
  });

  it('restores from the trash through a confirm, and treats another tenant\x27s id as missing', async () => {
    const id = await newRecord('Back from the trash');
    await as(app.ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    const proposed = await propose(app, admin, 'admin', [
      { tool: 'admin_propose_restore', args: { kind: 'record', id } },
    ]);
    const res = await confirm(app.ctx, admin, proposed.actionIds[0]).expect(200);
    expect(res.body.action.result).toMatchObject({
      resourceType: 'record',
      id,
      link: `/records/${id}`,
    });
    await as(app.ctx, admin).get(`/api/v1/records/${id}`).expect(200);

    const other = await signUp(app.ctx);
    const foreign = await propose(app, other, 'admin', [
      { tool: 'admin_propose_restore', args: { kind: 'record', id } },
    ]);
    expect(foreign.actionIds).toEqual([]);
    expect(foreign.toolFrames.at(-1)).toMatchObject({ state: 'error', code: 'NOT_FOUND' });
  });

  it('drops a stored admin table for a reader who is no longer an admin', async () => {
    const second = await addMember(app.ctx, admin, 'admin');
    app.ai.script(
      [delegate('admin', 'List members'), reply('Here')],
      [calls(toolCall('a1', 'admin_list_members', {})), reply('Listed')],
    );
    const res = await chat(app.ctx, second, chatBody({ message: 'Members?' }));
    const sessionId = (res.frames[0] as { sessionId: string }).sessionId;
    const before = await as(app.ctx, second).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    expect(before.body.messages.at(-1).blocks).toEqual([
      expect.objectContaining({ kind: 'table' }),
    ]);
    await as(app.ctx, admin)
      .patch(`/api/v1/members/${second.userId}`)
      .send({ role: 'member' })
      .expect(200);
    const after = await as(app.ctx, second).get(`/api/v1/ai/sessions/${sessionId}`).expect(200);
    expect(after.body.messages.at(-1).blocks).toEqual([]);
    expect(JSON.stringify(after.body)).not.toContain(member.email);
    expect(
      await app.db
        .collection('ai_messages')
        .countDocuments({ sessionId: new Types.ObjectId(sessionId) }),
    ).toBe(2);
  });

  const trashedRecord = async (name: string) => {
    const id = await newRecord(name);
    await as(app.ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
    return id;
  };

  it('takes the restore origin from the trashed id, and reduces the action for a demoted reader', async () => {
    const second = await addMember(app.ctx, admin, 'admin');
    const id = await trashedRecord('Trashed Okapi 12');
    const derived = await propose(app, second, 'admin', [
      { tool: 'admin_propose_restore', args: { kind: 'record', id } },
    ]);
    expect(derived.confirmBlocks[0]).toMatchObject({ origin: 'derived' });
    const proposed = await propose(
      app,
      second,
      'admin',
      [{ tool: 'admin_propose_restore', args: { kind: 'record', id } }],
      { message: `Restore ${id}` },
    );
    expect(proposed.confirmBlocks[0]).toMatchObject({ origin: 'user' });
    const actionId = proposed.actionIds[0];
    const before = await as(app.ctx, second)
      .get(`/api/v1/ai/sessions/${proposed.sessionId}`)
      .expect(200);
    expect(before.body.actions[0]).toMatchObject({
      id: actionId,
      preview: { title: 'Restore record “Trashed Okapi 12”' },
    });

    await as(app.ctx, admin)
      .patch(`/api/v1/members/${second.userId}`)
      .send({ role: 'member' })
      .expect(200);
    const after = await as(app.ctx, second)
      .get(`/api/v1/ai/sessions/${proposed.sessionId}`)
      .expect(200);
    expect(after.body.actions[0]).toMatchObject({
      id: actionId,
      status: 'pending',
      preview: { unavailable: true, actionId },
    });
    expect(JSON.stringify(after.body)).not.toContain('Okapi');
    const cancelled = await as(app.ctx, second)
      .post(`/api/v1/ai/actions/${actionId}/cancel`)
      .expect(200);
    expect(cancelled.body.action.preview).toMatchObject({ unavailable: true });
    expect(JSON.stringify(cancelled.body)).not.toContain('Okapi');
  });

  it('re-gates a restore at confirm: a demotion since the proposal gives 403 and a failed action', async () => {
    const second = await addMember(app.ctx, admin, 'admin');
    const id = await trashedRecord('Stays in the trash');
    const proposed = await propose(
      app,
      second,
      'admin',
      [{ tool: 'admin_propose_restore', args: { kind: 'record', id } }],
      { message: `Restore ${id}` },
    );
    expect(proposed.actionIds).toHaveLength(1);
    await as(app.ctx, admin)
      .patch(`/api/v1/members/${second.userId}`)
      .send({ role: 'member' })
      .expect(200);
    const res = await confirm(app.ctx, second, proposed.actionIds[0]).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(
      await app.db
        .collection('ai_pending_actions')
        .findOne({ _id: new Types.ObjectId(proposed.actionIds[0]) }),
    ).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' });
    const trash = await as(app.ctx, admin).get('/api/v1/trash').expect(200);
    expect(JSON.stringify(trash.body)).toContain(id);
    const denied = await as(app.ctx, admin)
      .get(`/api/v1/audit?action=ACCESS_DENIED&actorId=${second.userId}&resourceId=${id}`)
      .expect(200);
    expect(denied.body.items).toEqual([
      expect.objectContaining({
        action: 'ACCESS_DENIED',
        context: expect.objectContaining({ attemptedAction: 'admin.overview' }),
      }),
    ]);
  });

  it("treats another tenant's record as missing in the collab tools: NOT_FOUND, no action row", async () => {
    const other = await signUp(app.ctx);
    const otherWs = await workspace(app.ctx, other, 'Elsewhere');
    const theirs = await createRecord(app.ctx, other, otherWs, { name: 'Foreign Narwhal 5' });
    const foreign = theirs.id;
    const foreignComment = await comment(other, foreign, 'Foreign words 5');
    const mine = await newRecord('Mine to relate');
    const rows = () =>
      app.db
        .collection('ai_pending_actions')
        .countDocuments({ userId: new Types.ObjectId(admin.userId) });
    const rowsBefore = await rows();

    app.ai.script(
      [delegate('collab', `List the comments on ${foreign}`), reply('Not found')],
      [calls(toolCall('c1', 'collab_list_comments', { recordId: foreign })), reply('Not found')],
    );
    const listed = await chat(app.ctx, admin, chatBody({ message: `Comments on ${foreign}?` }));
    expect(listed.frames.filter((frame) => frame.type === 'tool').at(-1)).toMatchObject({
      tool: 'collab_list_comments',
      state: 'error',
      code: 'NOT_FOUND',
    });
    expect(listed.raw).not.toContain('Foreign words 5');
    expect(app.ai.promptsText()).not.toContain('Foreign words 5');

    const related = await propose(
      app,
      admin,
      'collab',
      [
        {
          tool: 'collab_propose_relation',
          args: { recordId: mine, otherId: foreign, kind: 'references', direction: null },
        },
      ],
      { message: `Relate ${mine} to ${foreign}` },
    );
    expect(related.actionIds).toEqual([]);
    expect(related.toolFrames.at(-1)).toMatchObject({ state: 'error', code: 'NOT_FOUND' });

    const removed = await propose(
      app,
      admin,
      'collab',
      [
        {
          tool: 'collab_propose_delete_comment',
          args: { recordId: foreign, commentId: foreignComment },
        },
      ],
      { message: `Delete comment ${foreignComment} on ${foreign}` },
    );
    expect(removed.actionIds).toEqual([]);
    expect(removed.toolFrames.at(-1)).toMatchObject({ state: 'error', code: 'NOT_FOUND' });

    expect(await rows()).toBe(rowsBefore);
    expect(JSON.stringify(related.res.raw + removed.res.raw)).not.toContain('Foreign Narwhal 5');
    const left = await as(app.ctx, other).get(`/api/v1/records/${foreign}/comments`).expect(200);
    expect((left.body as Array<{ id: string }>).map((c) => c.id)).toEqual([foreignComment]);
  });
});
