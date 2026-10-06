import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { AiAuditTrail } from '../ai-audit-trail.js';
import type { BlockDraft } from '../blocks.js';
import type { AiActionsRepository } from '../data/ai-data.repositories.js';
import type { Preview } from '../tools/proposal.js';
import { reducedActionView, reducedPreview, targetsVisible, toActionView } from './action-view.js';
import { MAX_ACTIONS_PER_TURN, originOf, TurnProposals, userNamedIds } from './turn-proposals.js';

const RECORD = 'a'.repeat(24);
const FOLDER = 'b'.repeat(24);
const OTHER = 'c'.repeat(24);

describe('origin', () => {
  it('collects the ids the user named in the message and the resolved page context', () => {
    const ids = userNamedIds(`Rename ${RECORD.toUpperCase()} please`, {
      currentFolder: { id: FOLDER },
      selectedRecords: [{ id: OTHER }],
    });
    expect([...ids].sort()).toEqual([RECORD, FOLDER, OTHER].sort());
  });

  it('is user only when every target was named by the user; a create without targets is user', () => {
    const named = new Set([RECORD]);
    expect(originOf({ records: [RECORD], folders: [] }, named)).toBe('user');
    expect(originOf({ records: [], folders: [] }, named)).toBe('user');
    expect(originOf({ records: [RECORD], folders: [OTHER] }, named)).toBe('derived');
  });

  it('counts originIds (a trashed item to restore, no target) for the origin too', () => {
    const none = { records: [], folders: [] };
    expect(originOf(none, new Set([RECORD]), [RECORD])).toBe('user');
    expect(originOf(none, new Set([RECORD]), [OTHER])).toBe('derived');
  });
});

function preview(overrides: Partial<Preview<unknown>> = {}): Preview<unknown> {
  return {
    args: { id: RECORD },
    base: null,
    title: 'Rename “X”',
    summary: 'Repository',
    changes: [],
    targets: { records: [RECORD], folders: [] },
    refs: [],
    destructive: false,
    reviewEach: false,
    needsFile: false,
    ...overrides,
  };
}

type UpdateArg = { $set?: Record<string, unknown> };

function store(
  createImpl?: (data: Record<string, unknown>) => Promise<unknown>,
  updateImpl?: (filter: Record<string, unknown>, update: UpdateArg) => Promise<unknown>,
) {
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<{ filter: unknown; update: unknown }> = [];
  const emitted: Array<{ block: BlockDraft; id: string }> = [];
  let blocks = 0;
  const proposals = new TurnProposals({
    actions: {
      create: vi.fn(async (_owner: unknown, data: Record<string, unknown>) => {
        if (createImpl) await createImpl(data);
        created.push(data);
        return data;
      }),
      updateOne: vi.fn(async (_owner: unknown, filter: unknown, update: unknown) => {
        updates.push({ filter, update });
        if (updateImpl) await updateImpl(filter as Record<string, unknown>, update as UpdateArg);
        return {};
      }),
      updateMany: vi.fn(async () => 1),
    } as unknown as AiActionsRepository,
    trail: { record: vi.fn(async () => undefined) } as unknown as AiAuditTrail,
    owner: { tenantId: '8'.repeat(24), userId: '9'.repeat(24) },
    sessionId: 'd'.repeat(24),
    messageId: new Types.ObjectId('e'.repeat(24)),
    ttlMinutes: 15,
    userIds: new Set([RECORD]),
    emit: (block, id) => emitted.push({ block, id }),
    nextBlockId: () => `m-${(blocks += 1)}`,
  });
  return { proposals, created, updates, emitted };
}

describe('TurnProposals', () => {
  it('stores one action without a plan and emits its confirm card with every flag', async () => {
    const { proposals, created, emitted } = store();
    const action = await proposals.propose({
      tool: 'records_propose_rename',
      domain: 'records',
      confirmLabel: 'update',
      preview: preview(),
    });
    expect(created[0]).toMatchObject({
      tool: 'records_propose_rename',
      status: 'pending',
      planId: null,
      step: null,
      dependsOn: null,
      origin: 'user',
      destructive: false,
      reviewEach: false,
      needsFile: false,
      confirmLabel: 'update',
      executingSince: null,
    });
    expect(emitted[0]).toMatchObject({
      id: 'm-1',
      block: {
        kind: 'confirm',
        actionId: action.actionId,
        destructive: false,
        needsFile: false,
        reviewEach: false,
        origin: 'user',
        confirmLabel: 'update',
      },
    });
    expect(proposals.planBlock()).toBeNull();
  });

  it('gives the first action a plan once a second one comes, and sets dependsOn from a Ref', async () => {
    const { proposals, created, updates } = store();
    const first = await proposals.propose({
      tool: 'folders_propose_create',
      domain: 'folders',
      confirmLabel: 'create',
      preview: preview({ targets: { records: [], folders: [] }, creates: 'Repository / New' }),
    });
    await proposals.propose({
      tool: 'records_propose_create',
      domain: 'records',
      confirmLabel: 'create',
      preview: preview({ targets: { records: [OTHER], folders: [] }, refs: [first.actionId] }),
    });
    const planId = created[1].planId as string;
    expect(planId).toEqual(expect.any(String));
    expect(updates[0]).toMatchObject({ update: { $set: { planId, step: 1 } } });
    expect(created[1]).toMatchObject({ step: 2, origin: 'derived' });
    expect((created[1].dependsOn as Types.ObjectId).toHexString()).toBe(first.actionId);
    expect(proposals.planned(first.actionId)).toMatchObject({
      step: 1,
      creates: 'Repository / New',
    });
    expect(proposals.planBlock()).toMatchObject({
      kind: 'plan',
      planId,
      steps: [
        { actionId: first.actionId, step: 1 },
        { step: 2, status: 'pending' },
      ],
    });
  });

  it('refuses a Ref to anything but an earlier action of this turn, and a plan that is too long', async () => {
    const { proposals } = store();
    await expect(
      proposals.propose({
        tool: 't',
        domain: 'records',
        confirmLabel: 'confirm',
        preview: preview({ refs: [OTHER] }),
      }),
    ).rejects.toBeInstanceOf(HttpException);
    for (let index = 0; index < MAX_ACTIONS_PER_TURN; index += 1) {
      await proposals.propose({
        tool: 't',
        domain: 'records',
        confirmLabel: 'confirm',
        preview: preview(),
      });
    }
    await expect(
      proposals.propose({
        tool: 't',
        domain: 'records',
        confirmLabel: 'confirm',
        preview: preview(),
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PLAN_TOO_LONG' }) });
  });
});

describe('TurnProposals ordering and closing', () => {
  const draft = (overrides: Partial<Preview<unknown>> = {}) => ({
    tool: 'folders_propose_create',
    domain: 'folders' as const,
    confirmLabel: 'create' as const,
    preview: preview({ targets: { records: [], folders: [] }, ...overrides }),
  });

  it('gives parallel proposals of one model step distinct steps and one plan', async () => {
    const { proposals, created, updates } = store(
      () => new Promise((resolve) => setTimeout(resolve, 5)),
    );
    const [first, second] = await Promise.all([
      proposals.propose(draft()),
      proposals.propose(draft()),
    ]);
    expect(created.map((row) => row.step)).toEqual([null, 2]);
    const planId = created[1].planId as string;
    expect(updates).toEqual([expect.objectContaining({ update: { $set: { planId, step: 1 } } })]);
    expect(proposals.planBlock()).toMatchObject({
      planId,
      steps: [
        { actionId: first.actionId, step: 1 },
        { actionId: second.actionId, step: 2 },
      ],
    });
  });

  it('does not use up a step when storing fails', async () => {
    let fail = true;
    const { proposals, created } = store(async () => {
      if (fail) {
        fail = false;
        throw new Error('write failed');
      }
    });
    await expect(proposals.propose(draft())).rejects.toThrow('write failed');
    await proposals.propose(draft());
    expect(created).toEqual([expect.objectContaining({ planId: null, step: null })]);
    expect(proposals.count).toBe(1);
  });

  it('refuses with TURN_ABORTED once closed, and cancels a row stored while it closed', async () => {
    let closing: TurnProposals | undefined;
    const { proposals, updates, emitted } = store(async () => closing?.close());
    closing = proposals;
    await expect(proposals.propose(draft())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TURN_ABORTED' }),
    });
    expect(updates).toEqual([
      expect.objectContaining({ update: { $set: { status: 'cancelled' } } }),
    ]);
    expect(emitted).toEqual([]);
    await expect(proposals.propose(draft())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TURN_ABORTED' }),
    });
    expect(proposals.planBlock()).toBeNull();
  });

  it('cancels the second row when the turn closes during the step-1 backfill: no card, no plan', async () => {
    let closing: TurnProposals | undefined;
    const { proposals, created, updates, emitted } = store(undefined, async (_filter, update) => {
      if (update.$set?.step === 1) closing?.close();
    });
    closing = proposals;
    const first = await proposals.propose(draft());
    await expect(proposals.propose(draft())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TURN_ABORTED' }),
    });
    expect(updates).toEqual([
      expect.objectContaining({ update: { $set: { planId: created[1].planId, step: 1 } } }),
      {
        filter: { _id: created[1]._id, status: 'pending' },
        update: { $set: { status: 'cancelled' } },
      },
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].block).toMatchObject({ actionId: first.actionId });
    expect(proposals.planBlock()).toBeNull();
    expect(proposals.count).toBe(1);
  });

  it('cancels the second row when the step-1 backfill fails, and passes the error on', async () => {
    const { proposals, created, updates, emitted } = store(undefined, async (_filter, update) => {
      if (update.$set?.step === 1) throw new Error('backfill failed');
    });
    await proposals.propose(draft());
    await expect(proposals.propose(draft())).rejects.toThrow('backfill failed');
    expect(updates.at(-1)).toEqual({
      filter: { _id: created[1]._id, status: 'pending' },
      update: { $set: { status: 'cancelled' } },
    });
    expect(emitted).toHaveLength(1);
    expect(proposals.planBlock()).toBeNull();
    expect(proposals.count).toBe(1);
  });
});

describe('toActionView', () => {
  it('shows a pending action past its expiry as expired, with executingSince as ISO', () => {
    const base = {
      _id: new Types.ObjectId(RECORD),
      tool: 'records_propose_rename',
      domain: 'records',
      preview: {},
      planId: null,
      step: null,
      dependsOn: null,
      needsFile: false,
      destructive: false,
      reviewEach: false,
      origin: 'user' as const,
      confirmLabel: 'update' as const,
      result: null,
      errorCode: null,
      executingSince: null,
    };
    const now = new Date('2026-09-30T12:00:00.000Z');
    const view = (overrides: Record<string, unknown>) =>
      toActionView({ ...base, ...overrides } as never, now);
    expect(
      view({ status: 'pending', expiresAt: new Date('2026-09-30T11:59:00.000Z') }).status,
    ).toBe('expired');
    expect(
      view({ status: 'pending', expiresAt: new Date('2026-09-30T12:01:00.000Z') }).status,
    ).toBe('pending');
    expect(
      view({
        status: 'executing',
        expiresAt: new Date('2026-09-30T11:59:00.000Z'),
        executingSince: new Date('2026-09-30T11:58:00.000Z'),
      }),
    ).toMatchObject({
      status: 'executing',
      executingSince: '2026-09-30T11:58:00.000Z',
      confirmLabel: 'update',
    });
  });
});

describe('reduced cards', () => {
  it('keeps only ids, flags and state of a card whose target is hidden', () => {
    const card = {
      kind: 'confirm',
      id: 'm-1',
      actionId: RECORD,
      title: 'Rename “Secret Llama”',
      summary: 'Repository / Hidden',
      changes: [{ label: 'Name', before: 'Secret Llama', after: 'X' }],
      destructive: false,
      needsFile: false,
      reviewEach: true,
      origin: 'user',
      confirmLabel: 'update',
      expiresAt: '2026-10-01T00:00:00.000Z',
    };
    expect(reducedPreview(card, 'done')).toEqual({
      kind: 'confirm',
      id: 'm-1',
      actionId: RECORD,
      unavailable: true,
      status: 'done',
      confirmLabel: 'update',
      destructive: false,
      needsFile: false,
      reviewEach: true,
      origin: 'user',
    });
    expect(reducedPreview({ actionId: RECORD }, 'pending')).toMatchObject({
      destructive: true,
      needsFile: true,
      reviewEach: true,
      origin: 'derived',
      confirmLabel: 'confirm',
    });
  });

  it('drops the result name from the view, and tells hidden targets from visible ones', () => {
    const view = reducedActionView({
      id: RECORD,
      tool: 'records_propose_rename',
      domain: 'records',
      status: 'done',
      preview: { actionId: RECORD, title: 'Secret' },
      planId: null,
      step: null,
      dependsOn: null,
      needsFile: false,
      destructive: false,
      reviewEach: false,
      origin: 'user',
      confirmLabel: 'update',
      result: {
        resourceType: 'record',
        id: RECORD,
        name: 'Secret Llama',
        link: `/records/${RECORD}`,
      },
      errorCode: null,
      expiresAt: '2026-10-01T00:00:00.000Z',
      executingSince: null,
    });
    expect(JSON.stringify(view)).not.toContain('Secret');
    expect(view.result).toEqual({ resourceType: 'record', id: RECORD, link: `/records/${RECORD}` });
    const visible = { records: new Set([RECORD]), folders: new Set<string>() };
    expect(targetsVisible({ records: [RECORD], folders: [] }, visible)).toBe(true);
    expect(targetsVisible({ records: [RECORD], folders: [FOLDER] }, visible)).toBe(false);
    expect(targetsVisible(undefined, visible)).toBe(true);
  });
});
