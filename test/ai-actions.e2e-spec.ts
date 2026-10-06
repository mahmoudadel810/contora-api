import { Types } from 'mongoose';
import { AccessService } from '../src/access/access.service.js';
import { BulkService } from '../src/bulk/bulk.service.js';
import { ContentTypesService } from '../src/content-types/content-types.service.js';
import { FoldersService } from '../src/folders/folders.service.js';
import { RecordsService } from '../src/records/records.service.js';
import { TrashService } from '../src/trash/trash.service.js';
import { AiAuditTrail } from '../src/ai/ai-audit-trail.js';
import { AiActionsRepository } from '../src/ai/data/ai-data.repositories.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import {
  baseUrlOf,
  chat,
  chatBody,
  createAiApp,
  eventually,
  NO_CONTEXT,
  openChat,
  type AiTestApp,
} from './helpers/ai.js';
import {
  cancelPath,
  confirm,
  confirmPath,
  grantEdit,
  propose,
  proposeAcross,
  withoutRequestId,
} from './helpers/ai-actions.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { calls, delegate, reply, toolCall } from './helpers/scripted-ai.js';

describe('AI actions: propose, confirm, cancel (e2e)', () => {
  let app: AiTestApp;
  let admin: Actor;
  let member: Actor;
  let peer: Actor;
  let ws: Workspace;

  const records = () => app.ctx.app.get(RecordsService);
  const actionRow = (id: string) =>
    app.db.collection('ai_pending_actions').findOne({ _id: new Types.ObjectId(id) });
  const newRecord = async (name: string, metadata?: Record<string, unknown>) =>
    (await createRecord(app.ctx, admin, ws, { name, ...(metadata ? { metadata } : {}) })).id;
  const recordOf = async (id: string) =>
    (await as(app.ctx, admin).get(`/api/v1/records/${id}`).expect(200)).body.record as Record<
      string,
      unknown
    >;
  const subfolder = async (name: string, parentId = ws.folderId) =>
    (await as(app.ctx, admin).post('/api/v1/folders').send({ name, parentId }).expect(201)).body
      .id as string;

  async function proposeOne(
    actor: Actor,
    domain: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const ids = Object.values(args).flatMap((value) =>
      typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) ? [value] : [],
    );
    const proposed = await propose(app, actor, domain, [{ tool, args }], {
      message: `Please do it: ${ids.join(' ')}`,
    });
    expect(proposed.actionIds, JSON.stringify(proposed.toolFrames)).toHaveLength(1);
    return proposed.actionIds[0];
  }

  const createArgs = (overrides: Record<string, unknown> = {}) => ({
    name: 'Invoice from the assistant',
    contentTypeId: ws.typeId,
    contentTypeRef: null,
    folderId: ws.folderId,
    folderRef: null,
    metadata: [
      { key: 'supplier', value: 'Acme' },
      { key: 'amount', value: '10' },
    ],
    tags: null,
    comment: null,
    withFile: null,
    ...overrides,
  });

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

  describe('propose', () => {
    it('stores pending actions and full confirm cards, and calls no service write method', async () => {
      const a = await newRecord('Propose A');
      const b = await newRecord('Propose B');
      const targets: Array<[object, string]> = [
        [records(), 'create'],
        [records(), 'rename'],
        [records(), 'move'],
        [records(), 'setTags'],
        [records(), 'changeTags'],
        [records(), 'addVersion'],
        [records(), 'restoreVersion'],
        [records(), 'checkOut'],
        [records(), 'checkIn'],
        [app.ctx.app.get(TrashService), 'trashRecord'],
        [app.ctx.app.get(TrashService), 'trashFolder'],
        [app.ctx.app.get(BulkService), 'trashRecords'],
        [app.ctx.app.get(FoldersService), 'create'],
        [app.ctx.app.get(FoldersService), 'rename'],
        [app.ctx.app.get(FoldersService), 'move'],
        [app.ctx.app.get(ContentTypesService), 'create'],
        [app.ctx.app.get(ContentTypesService), 'update'],
        [app.ctx.app.get(ContentTypesService), 'setArchived'],
      ];
      const spies = targets.map(([service, method]) =>
        vi.spyOn(service as Record<string, (...args: unknown[]) => unknown>, method),
      );
      try {
        const proposed = await propose(
          app,
          member,
          'records',
          [
            { tool: 'records_propose_rename', args: { id: a, name: 'Propose A renamed' } },
            { tool: 'records_propose_set_tags', args: { id: a, add: ['urgent'], remove: null } },
            { tool: 'records_propose_trash', args: { ids: [a, b] } },
          ],
          { message: `Rename, tag and trash ${a} and ${b}` },
        );
        await propose(app, admin, 'schema', [
          {
            tool: 'schema_propose_update_fields',
            args: {
              id: ws.typeId,
              add: null,
              relabel: [{ key: 'amount', label: 'Total' }],
              reorder: null,
              setRequired: null,
            },
          },
        ]);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();

        expect(proposed.actionIds).toHaveLength(3);
        for (const block of proposed.confirmBlocks) {
          expect(block).toEqual({
            kind: 'confirm',
            id: expect.any(String),
            actionId: expect.stringMatching(/^[a-f0-9]{24}$/),
            title: expect.any(String),
            summary: expect.any(String),
            changes: expect.any(Array),
            destructive: expect.any(Boolean),
            needsFile: false,
            reviewEach: false,
            origin: 'user',
            confirmLabel: expect.stringMatching(/^(update|trash)$/),
            expiresAt: expect.any(String),
          });
        }
        expect(proposed.confirmBlocks.map((block) => block.confirmLabel)).toEqual([
          'update',
          'update',
          'trash',
        ]);
        expect(proposed.confirmBlocks[2]).toMatchObject({
          destructive: true,
          title: 'Move 2 records to the trash',
          changes: [
            { label: 'Propose A', after: 'Trash' },
            { label: 'Propose B', after: 'Trash' },
          ],
        });
        const [plan] = proposed.planBlocks;
        expect(plan).toMatchObject({ kind: 'plan', title: '3 steps' });
        const rows = await Promise.all(proposed.actionIds.map(actionRow));
        expect(rows.map((row) => row?.status)).toEqual(['pending', 'pending', 'pending']);
        expect(rows.map((row) => row?.step)).toEqual([1, 2, 3]);
        expect(rows.map((row) => row?.confirmLabel)).toEqual(['update', 'update', 'trash']);
        expect(new Set(rows.map((row) => row?.planId))).toEqual(new Set([plan.planId]));
        expect(rows[0]).toMatchObject({
          args: { id: a, name: 'Propose A renamed' },
          base: { name: 'Propose A' },
        });
        expect((await recordOf(a)).name).toBe('Propose A');

        const events = await app.db
          .collection('ai_audit_events')
          .find({ sessionId: new Types.ObjectId(proposed.sessionId), kind: 'action_proposed' })
          .toArray();
        expect(events).toHaveLength(3);
        for (const event of events)
          expect(event).toMatchObject({ isWrite: true, confirmed: false });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('marks a proposal whose target came only from content as derived', async () => {
      const id = await newRecord('Found by a search');
      const named = await propose(
        app,
        member,
        'records',
        [{ tool: 'records_propose_rename', args: { id, name: 'Named' } }],
        { context: { ...NO_CONTEXT, page: 'record', recordId: id } },
      );
      expect(named.confirmBlocks[0]).toMatchObject({ origin: 'user' });
      const derived = await propose(
        app,
        member,
        'records',
        [{ tool: 'records_propose_rename', args: { id, name: 'Derived' } }],
        { message: 'Rename whatever that document says' },
      );
      expect(derived.confirmBlocks[0]).toMatchObject({ origin: 'derived' });
      expect((await actionRow(derived.actionIds[0]))?.origin).toBe('derived');
    });

    it('refuses as a value, storing nothing, when the user cannot edit the target', async () => {
      const outsider = await addMember(app.ctx, admin);
      const id = await newRecord('Not for outsiders');
      const proposed = await propose(app, outsider, 'records', [
        { tool: 'records_propose_rename', args: { id, name: 'Mine now' } },
      ]);
      expect(proposed.actionIds).toEqual([]);
      expect(proposed.toolFrames.at(-1)).toMatchObject({
        tool: 'records_propose_rename',
        state: 'error',
        code: 'NOT_FOUND',
      });
      expect(proposed.res.raw).not.toContain('Not for outsiders');
      expect(
        await app.db
          .collection('ai_pending_actions')
          .countDocuments({ userId: new Types.ObjectId(outsider.userId) }),
      ).toBe(0);
    });
  });

  describe('confirm each kind', () => {
    it('creates a record', async () => {
      const actionId = await proposeOne(member, 'records', 'records_propose_create', createArgs());
      const res = await confirm(app.ctx, member, actionId).expect(200);
      expect(res.body.action).toMatchObject({
        id: actionId,
        status: 'done',
        executingSince: expect.any(String),
        result: { resourceType: 'record', name: 'Invoice from the assistant' },
      });
      const created = await recordOf(res.body.action.result.id as string);
      expect(created).toMatchObject({
        folderId: ws.folderId,
        metadata: { supplier: 'Acme', amount: 10 },
      });
      expect(res.body.action.result.link).toBe(`/records/${created.id as string}`);
    });

    it('creates a record with the file picked on the card (FILE_REQUIRED without it)', async () => {
      const actionId = await proposeOne(
        member,
        'records',
        'records_propose_create',
        createArgs({ name: 'Scanned invoice', withFile: true }),
      );
      const missing = await confirm(app.ctx, member, actionId).expect(409);
      expect(missing.body.code).toBe('FILE_REQUIRED');
      expect((await actionRow(actionId))?.status).toBe('pending');
      const res = await as(app.ctx, member)
        .post(confirmPath(actionId))
        .attach('file', Buffer.from('scanned bytes'), {
          filename: 'scan.txt',
          contentType: 'text/plain',
        })
        .expect(200);
      const created = await recordOf(res.body.action.result.id as string);
      expect(created.file).toMatchObject({ fileName: 'scan.txt' });
    });

    it('adds a metadata version from the delta, keeping the other values', async () => {
      const id = await newRecord('Versioned', { supplier: 'Keep me', amount: 5 });
      const actionId = await proposeOne(member, 'records', 'records_propose_new_version', {
        id,
        metadata: [{ key: 'amount', value: '7' }],
        comment: 'Corrected',
        withFile: null,
      });
      await confirm(app.ctx, member, actionId).expect(200);
      expect(await recordOf(id)).toMatchObject({
        currentVersion: 2,
        metadata: { supplier: 'Keep me', amount: 7 },
      });
    });

    it('renames, moves, retags, restores, checks out and checks in', async () => {
      const id = await newRecord('Many steps', { supplier: 'V1', amount: 1 });
      const target = await subfolder('Moved here');
      await confirm(
        app.ctx,
        member,
        await proposeOne(member, 'records', 'records_propose_rename', {
          id,
          name: 'Renamed by AI',
        }),
      ).expect(200);
      const move = await proposeOne(member, 'records', 'records_propose_move', {
        id,
        folderId: target,
      });
      expect((await actionRow(move))?.reviewEach).toBe(true);
      await confirm(app.ctx, member, move).expect(200);
      await confirm(
        app.ctx,
        member,
        await proposeOne(member, 'records', 'records_propose_set_tags', {
          id,
          add: ['ai'],
          remove: null,
        }),
      ).expect(200);
      await as(app.ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'V2', amount: 2 } })
        .expect(201);
      await confirm(
        app.ctx,
        member,
        await proposeOne(member, 'records', 'records_propose_restore_version', {
          id,
          versionNumber: 1,
          comment: null,
        }),
      ).expect(200);
      expect(await recordOf(id)).toMatchObject({
        name: 'Renamed by AI',
        folderId: target,
        tags: ['ai'],
        currentVersion: 3,
        metadata: { supplier: 'V1', amount: 1 },
      });
      await confirm(
        app.ctx,
        member,
        await proposeOne(member, 'records', 'records_propose_checkout', { id }),
      ).expect(200);
      expect((await recordOf(id)).checkedOut).toMatchObject({ id: member.userId });
      await confirm(
        app.ctx,
        member,
        await proposeOne(member, 'records', 'records_propose_checkin', { id }),
      ).expect(200);
      expect((await recordOf(id)).checkedOut).toBeNull();
    });

    it('trashes one record only with acknowledgeDestructive, and several with a partial result', async () => {
      const one = await newRecord('Trash me');
      const actionId = await proposeOne(member, 'records', 'records_propose_trash', { ids: [one] });
      const refused = await confirm(app.ctx, member, actionId).expect(409);
      expect(refused.body.code).toBe('CONFIRMATION_REQUIRED');
      expect((await actionRow(actionId))?.status).toBe('pending');
      const res = await confirm(app.ctx, member, actionId, { acknowledgeDestructive: true }).expect(
        200,
      );
      expect(res.body.action.result).toEqual({
        resourceType: 'record',
        id: one,
        name: 'Trash me',
        link: null,
      });
      await as(app.ctx, admin).get(`/api/v1/records/${one}`).expect(404);
      const repeat = await confirm(app.ctx, member, actionId).expect(409);
      expect(repeat.body).toMatchObject({
        code: 'ACTION_NOT_PENDING',
        details: { action: { id: actionId, status: 'done' } },
      });

      const free = await newRecord('Bulk free');
      const held = await newRecord('Bulk held');
      const bulk = await proposeOne(member, 'records', 'records_propose_trash', {
        ids: [free, held],
      });
      await as(app.ctx, peer).post(`/api/v1/records/${held}/checkout`).expect(200);
      const partial = await as(app.ctx, member)
        .post(confirmPath(bulk))
        .field('acknowledgeDestructive', 'true')
        .expect(200);
      expect(partial.body.action).toMatchObject({
        status: 'partial',
        result: {
          resourceType: 'records',
          count: 1,
          failed: [{ id: held, code: 'RECORD_CHECKED_OUT' }],
        },
      });
    });

    it('creates, renames, moves and trashes folders', async () => {
      const parent = await subfolder('Folder work');
      const other = await subfolder('Folder target');
      const created = await confirm(
        app.ctx,
        member,
        await proposeOne(member, 'folders', 'folders_propose_create', {
          name: 'Made by AI',
          parentId: parent,
          parentRef: null,
        }),
      ).expect(200);
      const folderId = created.body.action.result.id as string;
      expect(created.body.action.result).toMatchObject({
        resourceType: 'folder',
        link: `/repository/${folderId}`,
      });
      await confirm(
        app.ctx,
        member,
        await proposeOne(member, 'folders', 'folders_propose_rename', {
          id: folderId,
          name: 'Renamed folder',
        }),
      ).expect(200);
      await confirm(
        app.ctx,
        member,
        await proposeOne(member, 'folders', 'folders_propose_move', {
          id: folderId,
          parentId: other,
        }),
      ).expect(200);
      const moved = await as(app.ctx, admin).get(`/api/v1/folders/${folderId}`).expect(200);
      expect(moved.body.folder).toMatchObject({ name: 'Renamed folder', parentId: other });
      const trash = await proposeOne(member, 'folders', 'folders_propose_trash', { id: folderId });
      expect((await actionRow(trash))?.destructive).toBe(true);
      await confirm(app.ctx, member, trash, { acknowledgeDestructive: true }).expect(200);
      await as(app.ctx, admin).get(`/api/v1/folders/${folderId}`).expect(404);
    });

    it('lets an admin create a content type, add a field and archive it; keys come from labels', async () => {
      const field = (label: string, type = 'text') => ({
        label,
        type,
        required: null,
        options: null,
        min: null,
        max: null,
        maxLength: null,
        currency: null,
      });
      const created = await confirm(
        app.ctx,
        admin,
        await proposeOne(admin, 'schema', 'schema_propose_create_type', {
          name: 'Contract (AI)',
          description: null,
          fields: [field('Party'), field('Party')],
        }),
      ).expect(200);
      const typeId = created.body.action.result.id as string;
      await confirm(
        app.ctx,
        admin,
        await proposeOne(admin, 'schema', 'schema_propose_update_fields', {
          id: typeId,
          add: [field('Signed on', 'date')],
          relabel: [{ key: 'party2', label: 'Counterparty' }],
          reorder: null,
          setRequired: [{ key: 'party', required: true }],
        }),
      ).expect(200);
      const type = await as(app.ctx, admin).get(`/api/v1/content-types/${typeId}`).expect(200);
      expect(type.body.fields).toMatchObject([
        { key: 'party', label: 'Party', required: true },
        { key: 'party2', label: 'Counterparty' },
        { key: 'signedOn', type: 'date' },
      ]);
      await confirm(
        app.ctx,
        admin,
        await proposeOne(admin, 'schema', 'schema_propose_archive', { id: typeId, archived: true }),
      ).expect(200);
      expect(
        (await as(app.ctx, admin).get(`/api/v1/content-types/${typeId}`).expect(200)).body.status,
      ).toBe('archived');
    });
  });

  describe('confirm rules', () => {
    it('accepts the multipart flag and refuses a malformed body', async () => {
      const id = await newRecord('Body rules');
      const actionId = await proposeOne(member, 'records', 'records_propose_trash', { ids: [id] });
      const bad = await confirm(app.ctx, member, actionId, {
        acknowledgeDestructive: 'yes',
      }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
      await confirm(app.ctx, member, actionId, { extra: 1 }).expect(400);
      await as(app.ctx, member)
        .post(confirmPath(actionId))
        .field('acknowledgeDestructive', 'true')
        .expect(200);
    });

    it('never runs an expired action: 409 ACTION_EXPIRED, and the view says expired', async () => {
      const id = await newRecord('Expiring');
      const proposed = await propose(app, member, 'records', [
        { tool: 'records_propose_rename', args: { id, name: 'Too late' } },
      ]);
      const [actionId] = proposed.actionIds;
      await app.db
        .collection('ai_pending_actions')
        .updateOne(
          { _id: new Types.ObjectId(actionId) },
          { $set: { expiresAt: new Date(Date.now() - 1000) } },
        );
      const detail = await as(app.ctx, member)
        .get(`/api/v1/ai/sessions/${proposed.sessionId}`)
        .expect(200);
      expect(detail.body.actions[0]).toMatchObject({ id: actionId, status: 'expired' });
      const res = await confirm(app.ctx, member, actionId).expect(409);
      expect(res.body.code).toBe('ACTION_EXPIRED');
      expect((await actionRow(actionId))?.status).toBe('expired');
      expect((await recordOf(id)).name).toBe('Expiring');
    });

    it("answers another user's and another tenant's action with the same 404 as an unknown id", async () => {
      const id = await newRecord('Owned');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Stolen',
      });
      const stranger = await signUp(app.ctx);
      const unknown = await confirm(app.ctx, member, new Types.ObjectId().toHexString()).expect(
        404,
      );
      for (const other of [peer, admin, stranger]) {
        const confirmed = await confirm(app.ctx, other, actionId, {
          acknowledgeDestructive: true,
        }).expect(404);
        const cancelled = await as(app.ctx, other).post(cancelPath(actionId)).expect(404);
        expect(withoutRequestId(confirmed.body)).toEqual(withoutRequestId(unknown.body));
        expect(withoutRequestId(cancelled.body)).toEqual(withoutRequestId(unknown.body));
      }
      expect((await actionRow(actionId))?.status).toBe('pending');
      expect((await recordOf(id)).name).toBe('Owned');
    });

    it('passes the service error through unchanged and marks the action failed', async () => {
      const id = await newRecord('Held by peer');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Blocked',
      });
      await as(app.ctx, peer).post(`/api/v1/records/${id}/checkout`).expect(200);
      const direct = await as(app.ctx, member)
        .patch(`/api/v1/records/${id}`)
        .send({ name: 'Blocked' })
        .expect(409);
      const res = await confirm(app.ctx, member, actionId).expect(409);
      expect(withoutRequestId(res.body)).toEqual(withoutRequestId(direct.body));
      expect(await actionRow(actionId)).toMatchObject({
        status: 'failed',
        errorCode: 'RECORD_CHECKED_OUT',
      });
      const again = await confirm(app.ctx, member, actionId).expect(409);
      expect(again.body).toMatchObject({
        code: 'ACTION_NOT_PENDING',
        details: { action: { id: actionId, status: 'failed', errorCode: 'RECORD_CHECKED_OUT' } },
      });
      const failed = await app.db.collection('ai_audit_events').findOne({
        kind: 'action_failed',
        tool: 'records_propose_rename',
        errorCode: 'RECORD_CHECKED_OUT',
      });
      expect(failed).toMatchObject({ isWrite: true, confirmed: true, outcome: 'refused' });
    });

    it('writes AI_ACTION_CONFIRMED next to the service entry, an action_confirmed event and a note', async () => {
      const id = await newRecord('Audited');
      const proposed = await propose(
        app,
        member,
        'records',
        [{ tool: 'records_propose_rename', args: { id, name: 'Audited by AI' } }],
        { message: `Rename ${id}` },
      );
      const [actionId] = proposed.actionIds;
      await confirm(app.ctx, member, actionId).expect(200);
      const audit = await as(app.ctx, admin).get(`/api/v1/audit?resourceId=${id}`).expect(200);
      const actions = (audit.body.items as Array<{ action: string }>).map((entry) => entry.action);
      expect(actions).toEqual(expect.arrayContaining(['RECORD_UPDATED', 'AI_ACTION_CONFIRMED']));
      const entry = (audit.body.items as Array<Record<string, unknown>>).find(
        (item) => item.action === 'AI_ACTION_CONFIRMED',
      );
      expect(entry).toMatchObject({
        actor: { id: member.userId },
        resource: { type: 'record', id },
        context: { tool: 'records_propose_rename', actionId, sessionId: proposed.sessionId },
      });
      const event = await app.db.collection('ai_audit_events').findOne({
        sessionId: new Types.ObjectId(proposed.sessionId),
        kind: 'action_confirmed',
      });
      expect(event).toMatchObject({
        isWrite: true,
        confirmed: true,
        outcome: 'ok',
        tool: 'records_propose_rename',
      });
      const detail = await as(app.ctx, member)
        .get(`/api/v1/ai/sessions/${proposed.sessionId}`)
        .expect(200);
      expect(detail.body.messages.at(-1)).toMatchObject({
        role: 'assistant',
        text: '✓ Renamed “Audited” to “Audited by AI”',
      });
      expect(detail.body.actions).toEqual([
        expect.objectContaining({
          id: actionId,
          status: 'done',
          origin: 'user',
          confirmLabel: 'update',
          result: { resourceType: 'record', id, name: 'Audited by AI', link: `/records/${id}` },
        }),
      ]);
    });

    it('cancels a pending action once; a cancelled action cannot be confirmed', async () => {
      const id = await newRecord('Cancel me');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Never',
      });
      const res = await as(app.ctx, member).post(cancelPath(actionId)).expect(200);
      expect(res.body.action).toMatchObject({ id: actionId, status: 'cancelled' });
      const twice = await as(app.ctx, member).post(cancelPath(actionId)).expect(409);
      expect(twice.body).toMatchObject({
        code: 'ACTION_NOT_PENDING',
        details: { action: { status: 'cancelled' } },
      });
      expect((await confirm(app.ctx, member, actionId).expect(409)).body.code).toBe(
        'ACTION_NOT_PENDING',
      );
      expect((await recordOf(id)).name).toBe('Cancel me');
    });
  });

  describe('plans and refs', () => {
    const latestActionOf = async (actor: Actor) => {
      const [latest] = await app.db
        .collection('ai_pending_actions')
        .find({ userId: new Types.ObjectId(actor.userId) })
        .sort({ _id: -1 })
        .limit(1)
        .toArray();
      return latest._id.toHexString();
    };

    const folderThenRecord = () =>
      proposeAcross(app, member, [
        {
          domain: 'folders',
          calls: [
            {
              tool: 'folders_propose_create',
              args: {
                name: `Plan ${new Types.ObjectId().toHexString()}`,
                parentId: ws.folderId,
                parentRef: null,
              },
            },
          ],
        },
        {
          domain: 'records',
          calls: [
            {
              tool: 'records_propose_create',
              args: async () =>
                createArgs({
                  name: 'Planned record',
                  folderId: null,
                  folderRef: await latestActionOf(member),
                }),
            },
          ],
        },
      ]);

    it('runs a plan in order: a step waits for the one it refers to, then uses what it created', async () => {
      const proposed = await folderThenRecord();
      expect(proposed.actionIds).toHaveLength(2);
      const [first, second] = proposed.actionIds;
      expect(proposed.planBlocks[0]).toMatchObject({
        title: '2 steps',
        steps: [
          { actionId: first, step: 1 },
          { actionId: second, step: 2 },
        ],
      });
      expect((await actionRow(second))?.dependsOn?.toHexString()).toBe(first);
      const early = await confirm(app.ctx, member, second).expect(409);
      expect(early.body.code).toBe('ACTION_DEPENDENCY_PENDING');
      expect((await actionRow(second))?.status).toBe('pending');
      const folder = await confirm(app.ctx, member, first).expect(200);
      const record = await confirm(app.ctx, member, second).expect(200);
      expect(await recordOf(record.body.action.result.id as string)).toMatchObject({
        folderId: folder.body.action.result.id,
      });
    });

    it('refuses a step whose dependency was cancelled', async () => {
      const proposed = await folderThenRecord();
      const [first, second] = proposed.actionIds;
      await as(app.ctx, member).post(cancelPath(first)).expect(200);
      const res = await confirm(app.ctx, member, second).expect(409);
      expect(res.body.code).toBe('ACTION_DEPENDENCY_FAILED');
      expect((await actionRow(second))?.status).toBe('pending');
    });

    it('gives a single proposal no plan, and refuses a Ref to an action of another answer', async () => {
      const earlier = await propose(app, member, 'folders', [
        {
          tool: 'folders_propose_create',
          args: {
            name: `Lone ${new Types.ObjectId().toHexString()}`,
            parentId: ws.folderId,
            parentRef: null,
          },
        },
      ]);
      expect(earlier.planBlocks).toEqual([]);
      expect(await actionRow(earlier.actionIds[0])).toMatchObject({
        planId: null,
        step: null,
        dependsOn: null,
      });
      const later = await propose(app, member, 'records', [
        {
          tool: 'records_propose_create',
          args: createArgs({ folderId: null, folderRef: earlier.actionIds[0] }),
        },
      ]);
      expect(later.actionIds).toEqual([]);
      expect(later.toolFrames.at(-1)).toMatchObject({ state: 'error', code: 'INVALID_REF' });
    });
  });

  describe('stale proposals', () => {
    it('is ACTION_STALE when a field was added between propose and confirm, and removes nothing', async () => {
      const typeId = (
        await as(app.ctx, admin)
          .post('/api/v1/content-types')
          .send({
            name: `Stale type ${new Types.ObjectId().toHexString()}`,
            fields: [{ key: 'amount', label: 'Amount', type: 'number' }],
          })
          .expect(201)
      ).body.id as string;
      const actionId = await proposeOne(admin, 'schema', 'schema_propose_update_fields', {
        id: typeId,
        add: null,
        relabel: [{ key: 'amount', label: 'Total' }],
        reorder: null,
        setRequired: null,
      });
      const types = app.ctx.app.get(ContentTypesService);
      const get = types.get.bind(types);
      const spy = vi.spyOn(types, 'get').mockImplementationOnce(async (...args) => {
        const current = await as(app.ctx, admin).get(`/api/v1/content-types/${typeId}`).expect(200);
        await as(app.ctx, admin)
          .patch(`/api/v1/content-types/${typeId}`)
          .send({
            name: current.body.name,
            description: current.body.description,
            fields: [...current.body.fields, { key: 'vat', label: 'VAT', type: 'number' }],
          })
          .expect(200);
        return get(...args);
      });
      try {
        const res = await confirm(app.ctx, admin, actionId).expect(409);
        expect(res.body.code).toBe('ACTION_STALE');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await actionRow(actionId)).toMatchObject({
        status: 'failed',
        errorCode: 'ACTION_STALE',
      });
      const type = await as(app.ctx, admin).get(`/api/v1/content-types/${typeId}`).expect(200);
      expect(type.body.fields).toMatchObject([
        { key: 'amount', label: 'Amount' },
        { key: 'vat', label: 'VAT' },
      ]);
    });

    it('is ACTION_STALE when a version was added since the proposal', async () => {
      const id = await newRecord('Stale record', { supplier: 'A', amount: 1 });
      const actionId = await proposeOne(member, 'records', 'records_propose_new_version', {
        id,
        metadata: [{ key: 'amount', value: '2' }],
        comment: null,
        withFile: null,
      });
      await as(app.ctx, admin)
        .post(`/api/v1/records/${id}/versions`)
        .send({ metadata: { supplier: 'B', amount: 9 } })
        .expect(201);
      expect((await confirm(app.ctx, member, actionId).expect(409)).body.code).toBe('ACTION_STALE');
      expect(await recordOf(id)).toMatchObject({
        currentVersion: 2,
        metadata: { supplier: 'B', amount: 9 },
      });
    });
  });

  describe('races', () => {
    it('double confirm: a second confirm at the claim wins, the first gets 409 and writes nothing', async () => {
      const id = await newRecord('Double click');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Once',
      });
      const repository = app.ctx.app.get(AiActionsRepository);
      const updateOne = repository.updateOne.bind(repository);
      const rename = vi.spyOn(records(), 'rename');
      let inner: { status: number; body: Record<string, unknown> } | null = null;
      const claim = vi.spyOn(repository, 'updateOne').mockImplementationOnce(async (...args) => {
        const res = await confirm(app.ctx, member, actionId);
        inner = { status: res.status, body: res.body as Record<string, unknown> };
        return updateOne(...args);
      });
      try {
        const outer = await confirm(app.ctx, member, actionId).expect(409);
        expect(outer.body).toMatchObject({
          code: 'ACTION_NOT_PENDING',
          details: { action: { id: actionId, status: 'done' } },
        });
        expect(inner).toMatchObject({ status: 200, body: { action: { status: 'done' } } });
        expect(claim).toHaveBeenCalled();
        expect(rename).toHaveBeenCalledTimes(1);
      } finally {
        claim.mockRestore();
        rename.mockRestore();
      }
    });

    it('confirm vs cancel: a cancel at the claim wins; the confirm gets 409 and writes nothing', async () => {
      const id = await newRecord('Confirm vs cancel');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Never',
      });
      const repository = app.ctx.app.get(AiActionsRepository);
      const updateOne = repository.updateOne.bind(repository);
      const rename = vi.spyOn(records(), 'rename');
      const claim = vi.spyOn(repository, 'updateOne').mockImplementationOnce(async (...args) => {
        await as(app.ctx, member).post(cancelPath(actionId)).expect(200);
        return updateOne(...args);
      });
      try {
        const res = await confirm(app.ctx, member, actionId).expect(409);
        expect(res.body).toMatchObject({
          code: 'ACTION_NOT_PENDING',
          details: { action: { id: actionId, status: 'cancelled' } },
        });
        expect(claim).toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
      } finally {
        claim.mockRestore();
        rename.mockRestore();
      }
      expect((await recordOf(id)).name).toBe('Confirm vs cancel');
    });

    it('a cancel during the execution is refused with the executing action', async () => {
      const id = await newRecord('Cancel while running');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Confirmed',
      });
      const service = records();
      const rename = service.rename.bind(service);
      let cancelBody: Record<string, unknown> = {};
      const spy = vi.spyOn(service, 'rename').mockImplementationOnce(async (...args) => {
        cancelBody = (await as(app.ctx, member).post(cancelPath(actionId)).expect(409)).body;
        return rename(...args);
      });
      try {
        await confirm(app.ctx, member, actionId).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(cancelBody).toMatchObject({
        code: 'ACTION_NOT_PENDING',
        details: { action: { status: 'executing', executingSince: expect.any(String) } },
      });
    });

    it('confirm vs revoke: access revoked during the confirm gives 404 and a failed action', async () => {
      const revoked = await addMember(app.ctx, admin);
      const grantId = await grantEdit(app.ctx, admin, revoked, ws.folderId);
      const id = await newRecord('Revoked meanwhile');
      const actionId = await proposeOne(revoked, 'records', 'records_propose_rename', {
        id,
        name: 'Too late',
      });
      const access = app.ctx.app.get(AccessService);
      const requireRecord = access.requireRecord.bind(access);
      const spy = vi.spyOn(access, 'requireRecord').mockImplementationOnce(async (...args) => {
        await as(app.ctx, admin).delete(`/api/v1/access/grants/${grantId}`).expect(200);
        return requireRecord(...args);
      });
      try {
        const res = await confirm(app.ctx, revoked, actionId).expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await actionRow(actionId)).toMatchObject({ status: 'failed', errorCode: 'NOT_FOUND' });
      expect((await recordOf(id)).name).toBe('Revoked meanwhile');
    });

    it('confirm vs trash: a record trashed during the confirm gives 404 and a failed action', async () => {
      const id = await newRecord('Trashed meanwhile');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Too late',
      });
      const access = app.ctx.app.get(AccessService);
      const requireRecord = access.requireRecord.bind(access);
      const spy = vi.spyOn(access, 'requireRecord').mockImplementationOnce(async (...args) => {
        await as(app.ctx, admin).delete(`/api/v1/records/${id}`).expect(204);
        return requireRecord(...args);
      });
      try {
        expect((await confirm(app.ctx, member, actionId).expect(404)).body.code).toBe('NOT_FOUND');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await actionRow(actionId)).toMatchObject({ status: 'failed', errorCode: 'NOT_FOUND' });
    });

    it('confirm vs check-out by another user: the service refusal comes back, the action failed', async () => {
      const id = await newRecord('Checked out meanwhile');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Too late',
      });
      const service = records();
      const rename = service.rename.bind(service);
      const spy = vi.spyOn(service, 'rename').mockImplementationOnce(async (...args) => {
        await as(app.ctx, peer).post(`/api/v1/records/${id}/checkout`).expect(200);
        return rename(...args);
      });
      try {
        expect((await confirm(app.ctx, member, actionId).expect(409)).body.code).toBe(
          'RECORD_CHECKED_OUT',
        );
      } finally {
        spy.mockRestore();
      }
      expect(await actionRow(actionId)).toMatchObject({
        status: 'failed',
        errorCode: 'RECORD_CHECKED_OUT',
      });
      expect((await recordOf(id)).name).toBe('Checked out meanwhile');
    });
  });

  describe('regenerate', () => {
    it('leaves the old answer and its pending actions alone when the regenerate fails', async () => {
      const id = await newRecord('Regen refused');
      const proposed = await propose(app, member, 'records', [
        { tool: 'records_propose_rename', args: { id, name: 'Still pending' } },
      ]);
      const trail = app.ctx.app.get(AiAuditTrail);
      const spy = vi.spyOn(trail, 'record').mockRejectedValueOnce(new Error('audit store down'));
      try {
        const refused = await chat(
          app.ctx,
          member,
          chatBody({ sessionId: proposed.sessionId, message: 'ignored', mode: 'regenerate' }),
        );
        expect(refused.status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const detail = await as(app.ctx, member)
        .get(`/api/v1/ai/sessions/${proposed.sessionId}`)
        .expect(200);
      expect(detail.body.messages.at(-1)).toMatchObject({ text: 'I prepared it; please confirm.' });
      expect((await actionRow(proposed.actionIds[0]))?.status).toBe('pending');
    });

    it('keeps the ✓ note and the confirmed action, and cancels what is still pending', async () => {
      const a = await newRecord('Regen A');
      const b = await newRecord('Regen B');
      const proposed = await propose(
        app,
        member,
        'records',
        [
          { tool: 'records_propose_rename', args: { id: a, name: 'Regen A done' } },
          { tool: 'records_propose_rename', args: { id: b, name: 'Regen B never' } },
        ],
        { message: `Rename ${a} and ${b}` },
      );
      const [done, pending] = proposed.actionIds;
      await confirm(app.ctx, member, done).expect(200);
      app.ai.script([reply('Here is another answer')]);
      const again = await chat(
        app.ctx,
        member,
        chatBody({ sessionId: proposed.sessionId, message: 'ignored', mode: 'regenerate' }),
      );
      expect(again.status).toBe(200);
      const detail = await as(app.ctx, member)
        .get(`/api/v1/ai/sessions/${proposed.sessionId}`)
        .expect(200);
      const texts = (detail.body.messages as Array<{ text: string }>).map(
        (message) => message.text,
      );
      expect(texts).toContain('✓ Renamed “Regen A” to “Regen A done”');
      expect(texts).toContain('Here is another answer');
      expect(texts).not.toContain('I prepared it; please confirm.');
      expect((await actionRow(done))?.status).toBe('done');
      expect((await actionRow(pending))?.status).toBe('cancelled');
      const note = await app.db
        .collection('ai_messages')
        .findOne({ kind: 'note', sessionId: new Types.ObjectId(proposed.sessionId) });
      expect(note).toMatchObject({ regenerated: false, role: 'assistant' });
    });
  });

  describe('proposal edge cases', () => {
    const field = (label: string, type = 'text') => ({
      label,
      type,
      required: null,
      options: null,
      min: null,
      max: null,
      maxLength: null,
      currency: null,
    });

    it('keeps empty metadata: a create without metadata and a file-only version confirm', async () => {
      const loose = (
        await as(app.ctx, admin)
          .post('/api/v1/content-types')
          .send({
            name: `Loose ${new Types.ObjectId().toHexString()}`,
            fields: [{ key: 'note', label: 'Note', type: 'text' }],
          })
          .expect(201)
      ).body.id as string;
      const create = await proposeOne(
        member,
        'records',
        'records_propose_create',
        createArgs({ name: 'No metadata', contentTypeId: loose, metadata: null }),
      );
      expect((await actionRow(create))?.args).toMatchObject({ metadata: {} });
      const created = await confirm(app.ctx, member, create).expect(200);
      const id = created.body.action.result.id as string;

      const version = await proposeOne(member, 'records', 'records_propose_new_version', {
        id,
        metadata: null,
        comment: null,
        withFile: true,
      });
      await as(app.ctx, member)
        .post(confirmPath(version))
        .attach('file', Buffer.from('v2 bytes'), { filename: 'v2.txt', contentType: 'text/plain' })
        .expect(200);
      expect(await recordOf(id)).toMatchObject({ currentVersion: 2, file: { fileName: 'v2.txt' } });
    });

    it('gives two proposals of one model step distinct steps and one plan', async () => {
      app.ai.script(
        [delegate('folders', 'Create two folders'), reply('Prepared both')],
        [
          calls(
            toolCall('p1', 'folders_propose_create', {
              name: `Twin A ${new Types.ObjectId().toHexString()}`,
              parentId: ws.folderId,
              parentRef: null,
            }),
            toolCall('p2', 'folders_propose_create', {
              name: `Twin B ${new Types.ObjectId().toHexString()}`,
              parentId: ws.folderId,
              parentRef: null,
            }),
          ),
          reply('Prepared'),
        ],
      );
      const res = await chat(
        app.ctx,
        member,
        chatBody({ message: `Two folders in ${ws.folderId}` }),
      );
      const blocks = res.frames
        .filter((frame) => frame.type === 'block')
        .map((frame) => (frame as unknown as { block: Record<string, unknown> }).block);
      const ids = blocks
        .filter((block) => block.kind === 'confirm')
        .map((b) => b.actionId as string);
      expect(ids).toHaveLength(2);
      const plan = blocks.find((block) => block.kind === 'plan') as {
        planId: string;
        steps: unknown[];
      };
      expect(plan.steps).toMatchObject([{ step: 1 }, { step: 2 }]);
      const rows = await Promise.all(ids.map(actionRow));
      expect(rows.map((row) => row?.step ?? 0).sort((x, y) => x - y)).toEqual([1, 2]);
      expect(new Set(rows.map((row) => row?.planId))).toEqual(new Set([plan.planId]));
    });

    it('stores nothing confirmable when the client stops during the dry run', async () => {
      const quitter = await addMember(app.ctx, admin);
      await grantEdit(app.ctx, admin, quitter, ws.folderId);
      const id = await newRecord('Abandoned');
      const service = records();
      const get = service.get.bind(service);
      let stream: Awaited<ReturnType<typeof openChat>> | null = null;
      const spy = vi.spyOn(service, 'get').mockImplementationOnce(async (...args) => {
        const open = await eventually(async () => stream);
        open.abort();
        await eventually(() =>
          app.db
            .collection('ai_messages')
            .findOne({ userId: new Types.ObjectId(quitter.userId), status: 'stopped' }),
        );
        return get(...args);
      });
      try {
        app.ai.script(
          [delegate('records', 'Rename it'), reply('never')],
          [calls(toolCall('p1', 'records_propose_rename', { id, name: 'Too late' })), reply('x')],
        );
        await baseUrlOf(app.ctx);
        stream = await openChat(app.ctx, quitter, chatBody({ message: `Rename ${id}` }));
        await stream.done;
        await eventually(async () => spy.mock.calls.length > 0);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        spy.mockRestore();
      }
      expect(
        await app.db.collection('ai_pending_actions').countDocuments({
          userId: new Types.ObjectId(quitter.userId),
          status: 'pending',
        }),
      ).toBe(0);
    });

    it('reduces a card whose target the reader can no longer see, in blocks and actions', async () => {
      const reader = await addMember(app.ctx, admin);
      const grantId = await grantEdit(app.ctx, admin, reader, ws.folderId);
      const id = await newRecord('Hidden Pangolin 77');
      const proposed = await propose(
        app,
        reader,
        'records',
        [{ tool: 'records_propose_rename', args: { id, name: 'Renamed Pangolin' } }],
        { message: `Rename ${id}` },
      );
      expect((await actionRow(proposed.actionIds[0]))?.targets).toEqual({
        records: [id],
        folders: [],
      });
      await as(app.ctx, admin).delete(`/api/v1/access/grants/${grantId}`).expect(200);
      const detail = await as(app.ctx, reader)
        .get(`/api/v1/ai/sessions/${proposed.sessionId}`)
        .expect(200);
      expect(JSON.stringify(detail.body)).not.toContain('Pangolin');
      const reduced = {
        kind: 'confirm',
        id: expect.any(String),
        actionId: proposed.actionIds[0],
        unavailable: true,
        status: 'pending',
        confirmLabel: 'update',
        destructive: false,
        needsFile: false,
        reviewEach: false,
        origin: 'user',
      };
      const card = (detail.body.messages.at(-1).blocks as Array<Record<string, unknown>>).find(
        (block) => block.kind === 'confirm',
      );
      expect(card).toEqual(reduced);
      expect(detail.body.actions[0].preview).toEqual(reduced);
    });

    it('reduces the action in cancel and refused-confirm answers once the target is hidden', async () => {
      const reader = await addMember(app.ctx, admin);
      const grantId = await grantEdit(app.ctx, admin, reader, ws.folderId);
      const doneId = await newRecord('Revoked Quokka 31');
      const pendingId = await newRecord('Revoked Quokka 32');
      const done = await proposeOne(reader, 'records', 'records_propose_rename', {
        id: doneId,
        name: 'Renamed Quokka',
      });
      const pending = await proposeOne(reader, 'records', 'records_propose_rename', {
        id: pendingId,
        name: 'Never Quokka',
      });
      const confirmed = await confirm(app.ctx, reader, done).expect(200);
      expect(confirmed.body.action.result).toMatchObject({ name: 'Renamed Quokka' });
      await as(app.ctx, admin).delete(`/api/v1/access/grants/${grantId}`).expect(200);

      const cancelDone = await as(app.ctx, reader).post(cancelPath(done)).expect(409);
      expect(cancelDone.body).toMatchObject({
        code: 'ACTION_NOT_PENDING',
        details: {
          action: { id: done, status: 'done', preview: { unavailable: true, actionId: done } },
        },
      });
      expect(cancelDone.body.details.action.result).toEqual({
        resourceType: 'record',
        id: doneId,
        link: `/records/${doneId}`,
      });
      expect(JSON.stringify(cancelDone.body)).not.toContain('Quokka');

      const confirmDone = await confirm(app.ctx, reader, done).expect(409);
      expect(confirmDone.body).toMatchObject({
        code: 'ACTION_NOT_PENDING',
        details: { action: { id: done, preview: { unavailable: true } } },
      });
      expect(JSON.stringify(confirmDone.body)).not.toContain('Quokka');

      const cancelled = await as(app.ctx, reader).post(cancelPath(pending)).expect(200);
      expect(cancelled.body.action).toMatchObject({
        id: pending,
        status: 'cancelled',
        preview: { unavailable: true, status: 'cancelled' },
      });
      expect(JSON.stringify(cancelled.body)).not.toContain('Quokka');
      expect((await recordOf(pendingId)).name).toBe('Revoked Quokka 32');
    });

    it('a demotion between propose and confirm gives the service 403 and a failed action', async () => {
      const second = await addMember(app.ctx, admin, 'admin');
      const actionId = await proposeOne(second, 'schema', 'schema_propose_archive', {
        id: ws.typeId,
        archived: true,
      });
      await as(app.ctx, admin)
        .patch(`/api/v1/members/${second.userId}`)
        .send({ role: 'member' })
        .expect(200);
      const res = await confirm(app.ctx, second, actionId).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(await actionRow(actionId)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' });
      expect(
        (await as(app.ctx, admin).get(`/api/v1/content-types/${ws.typeId}`).expect(200)).body
          .status,
      ).toBe('active');
    });

    describe('ACTION_STALE for each base', () => {
      const staleAfter = async (actionId: string, change: () => Promise<unknown>) => {
        await change();
        const res = await confirm(app.ctx, member, actionId).expect(409);
        expect(res.body.code).toBe('ACTION_STALE');
        expect(await actionRow(actionId)).toMatchObject({
          status: 'failed',
          errorCode: 'ACTION_STALE',
        });
      };

      it('record rename (name)', async () => {
        const id = await newRecord('Stale name');
        const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
          id,
          name: 'Mine',
        });
        await staleAfter(actionId, () =>
          as(app.ctx, admin).patch(`/api/v1/records/${id}`).send({ name: 'Theirs' }).expect(200),
        );
        expect((await recordOf(id)).name).toBe('Theirs');
      });

      it('record move (folderId)', async () => {
        const id = await newRecord('Stale place');
        const mine = await subfolder('Mine to move to');
        const theirs = await subfolder('Theirs to move to');
        const actionId = await proposeOne(member, 'records', 'records_propose_move', {
          id,
          folderId: mine,
        });
        await staleAfter(actionId, () =>
          as(app.ctx, admin)
            .post(`/api/v1/records/${id}/move`)
            .send({ folderId: theirs })
            .expect(200),
        );
        expect((await recordOf(id)).folderId).toBe(theirs);
      });

      it('folder rename (name) and folder move (parentId)', async () => {
        const folder = await subfolder('Stale folder');
        const target = await subfolder('Stale target');
        const elsewhere = await subfolder('Stale elsewhere');
        const rename = await proposeOne(member, 'folders', 'folders_propose_rename', {
          id: folder,
          name: 'Mine',
        });
        const move = await proposeOne(member, 'folders', 'folders_propose_move', {
          id: folder,
          parentId: target,
        });
        await staleAfter(rename, () =>
          as(app.ctx, admin)
            .patch(`/api/v1/folders/${folder}`)
            .send({ name: 'Theirs' })
            .expect(200),
        );
        await staleAfter(move, () =>
          as(app.ctx, admin)
            .post(`/api/v1/folders/${folder}/move`)
            .send({ parentId: elsewhere })
            .expect(200),
        );
      });

      it('record create (schemaVersion of the type)', async () => {
        const actionId = await proposeOne(
          member,
          'records',
          'records_propose_create',
          createArgs({ name: 'Stale create' }),
        );
        await staleAfter(actionId, async () => {
          const type = await as(app.ctx, admin)
            .get(`/api/v1/content-types/${ws.typeId}`)
            .expect(200);
          await as(app.ctx, admin)
            .patch(`/api/v1/content-types/${ws.typeId}`)
            .send({
              name: type.body.name,
              description: type.body.description,
              fields: [
                ...type.body.fields,
                { key: `extra${Date.now()}`, label: 'Extra', type: 'text' },
              ],
            })
            .expect(200);
        });
      });
    });

    it('creates a record of a content type planned earlier in the same answer (contentTypeRef)', async () => {
      const latestOf = async (actor: Actor) => {
        const [latest] = await app.db
          .collection('ai_pending_actions')
          .find({ userId: new Types.ObjectId(actor.userId) })
          .sort({ _id: -1 })
          .limit(1)
          .toArray();
        return latest._id.toHexString();
      };
      const proposed = await proposeAcross(app, admin, [
        {
          domain: 'schema',
          calls: [
            {
              tool: 'schema_propose_create_type',
              args: {
                name: `Planned type ${new Types.ObjectId().toHexString()}`,
                description: null,
                fields: [field('Reference')],
              },
            },
          ],
        },
        {
          domain: 'records',
          calls: [
            {
              tool: 'records_propose_create',
              args: async () =>
                createArgs({
                  name: 'Of a planned type',
                  contentTypeId: null,
                  contentTypeRef: await latestOf(admin),
                  metadata: [{ key: 'reference', value: 'R-1' }],
                }),
            },
          ],
        },
      ]);
      const [typeStep, recordStep] = proposed.actionIds;
      expect(proposed.actionIds).toHaveLength(2);
      const type = await confirm(app.ctx, admin, typeStep).expect(200);
      const record = await confirm(app.ctx, admin, recordStep).expect(200);
      expect(await recordOf(record.body.action.result.id as string)).toMatchObject({
        contentTypeId: type.body.action.result.id,
        metadata: { reference: 'R-1' },
      });
    });

    it('is ACTION_EXPIRED when the action expires between the pre-read and the claim', async () => {
      const id = await newRecord('Expires at the claim');
      const actionId = await proposeOne(member, 'records', 'records_propose_rename', {
        id,
        name: 'Late',
      });
      const repository = app.ctx.app.get(AiActionsRepository);
      const findById = repository.findById.bind(repository);
      const spy = vi.spyOn(repository, 'findById').mockImplementationOnce(async (...args) => {
        const found = await findById(...args);
        await app.db
          .collection('ai_pending_actions')
          .updateOne(
            { _id: new Types.ObjectId(actionId) },
            { $set: { expiresAt: new Date(Date.now() - 1000) } },
          );
        return found;
      });
      try {
        expect((await confirm(app.ctx, member, actionId).expect(409)).body.code).toBe(
          'ACTION_EXPIRED',
        );
      } finally {
        spy.mockRestore();
      }
      expect((await recordOf(id)).name).toBe('Expires at the claim');
    });
  });
});
