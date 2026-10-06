import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { errors } from '../../common/errors.js';
import type { AiAuditTrail } from '../ai-audit-trail.js';
import { summarizeArgs } from '../args-summary.js';
import type { ActionOrigin, BlockDraft, ConfirmBlock } from '../blocks.js';
import type { AiActionsRepository } from '../data/ai-data.repositories.js';
import type { Owner } from '../data/ai-owned.repository.js';
import {
  turnAborted,
  type PlannedAction,
  type ProposalDraft,
  type ProposedAction,
  type Targets,
} from '../tools/proposal.js';

export const MAX_ACTIONS_PER_TURN = 10;

const OBJECT_ID = /[a-f0-9]{24}/g;

export function userNamedIds(
  userText: string,
  context: {
    currentRecord?: { id: string };
    currentFolder?: { id: string };
    currentContentType?: { id: string };
    selectedRecords?: Array<{ id: string }>;
  },
): Set<string> {
  const ids = new Set(userText.toLowerCase().match(OBJECT_ID) ?? []);
  for (const item of [context.currentRecord, context.currentFolder, context.currentContentType]) {
    if (item) ids.add(item.id);
  }
  for (const item of context.selectedRecords ?? []) ids.add(item.id);
  return ids;
}

export function originOf(
  targets: Targets,
  userIds: ReadonlySet<string>,
  originIds: readonly string[] = [],
): ActionOrigin {
  return [...targets.records, ...targets.folders, ...originIds].every((id) => userIds.has(id))
    ? 'user'
    : 'derived';
}

interface Entry {
  id: Types.ObjectId;
  tool: string;
  step: number;
  args: unknown;
  creates: string | null;
  title: string;
}

export interface TurnProposalsDeps {
  actions: AiActionsRepository;
  trail: AiAuditTrail;
  owner: Owner;
  sessionId: string;
  messageId: Types.ObjectId;
  ttlMinutes: number;
  userIds: ReadonlySet<string>;
  emit(block: BlockDraft, id: string): void;
  nextBlockId(): string;
}

export class TurnProposals {
  private readonly entries: Entry[] = [];
  private planId: string | null = null;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TurnProposalsDeps) {}

  get count(): number {
    return this.entries.length;
  }

  close(): void {
    this.closed = true;
  }

  planned(actionId: string): PlannedAction | null {
    const entry = this.entries.find((candidate) => candidate.id.toHexString() === actionId);
    return entry
      ? {
          id: actionId,
          tool: entry.tool,
          step: entry.step,
          args: entry.args,
          creates: entry.creates,
        }
      : null;
  }

  propose(draft: ProposalDraft): Promise<ProposedAction> {
    if (this.closed) return Promise.reject(turnAborted());
    const run = this.chain.then(() => this.store(draft));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async store(draft: ProposalDraft): Promise<ProposedAction> {
    const { deps } = this;
    const { preview } = draft;
    if (this.closed) throw turnAborted();
    if (this.entries.length >= MAX_ACTIONS_PER_TURN) {
      throw errors.badRequest(
        'PLAN_TOO_LONG',
        `At most ${MAX_ACTIONS_PER_TURN} changes can be prepared in one answer`,
      );
    }
    const refs = preview.refs.map((ref) => {
      const entry = this.entries.find((candidate) => candidate.id.toHexString() === ref);
      if (!entry) throw errors.badRequest('INVALID_REF', 'Unknown *Ref');
      return entry;
    });
    const step = this.entries.length + 1;
    const opensPlan = step === 2;
    const planId = opensPlan ? randomUUID() : this.planId;
    const dependsOn = refs.reduce<Entry | null>(
      (latest, entry) => (latest === null || entry.step > latest.step ? entry : latest),
      null,
    );
    const origin = originOf(preview.targets, deps.userIds, preview.originIds);
    const id = new Types.ObjectId();
    const expiresAt = new Date(Date.now() + deps.ttlMinutes * 60_000);
    const blockId = deps.nextBlockId();
    const card: ConfirmBlock = {
      kind: 'confirm',
      id: blockId,
      actionId: id.toHexString(),
      title: preview.title,
      summary: preview.summary,
      changes: preview.changes,
      destructive: preview.destructive,
      needsFile: preview.needsFile,
      reviewEach: preview.reviewEach,
      origin,
      confirmLabel: draft.confirmLabel,
      expiresAt: expiresAt.toISOString(),
    };
    await deps.actions.create(deps.owner, {
      _id: id,
      sessionId: new Types.ObjectId(deps.sessionId),
      messageId: deps.messageId,
      tool: draft.tool,
      domain: draft.domain,
      args: preview.args as Record<string, unknown>,
      base: (preview.base ?? null) as Record<string, unknown> | null,
      preview: card as unknown as Record<string, unknown>,
      targets: preview.targets,
      planId,
      step: planId === null ? null : step,
      dependsOn: dependsOn?.id ?? null,
      origin,
      needsFile: preview.needsFile,
      destructive: preview.destructive,
      reviewEach: preview.reviewEach,
      confirmLabel: draft.confirmLabel,
      status: 'pending',
      result: null,
      errorCode: null,
      expiresAt,
      executingSince: null,
      executedAt: null,
    } as Parameters<AiActionsRepository['create']>[1]);
    try {
      if (opensPlan) {
        const [first] = this.entries;
        await deps.actions.updateOne(
          deps.owner,
          { _id: first.id, planId: null },
          { $set: { planId, step: 1 } },
        );
      }
      if (this.closed) throw turnAborted();
      if (opensPlan) this.planId = planId;
      this.entries.push({
        id,
        tool: draft.tool,
        step,
        args: preview.args,
        creates: preview.creates ?? null,
        title: preview.title,
      });
      const { id: _blockId, ...block } = card;
      deps.emit({ ...block, scope: { domain: draft.domain, targets: preview.targets } }, blockId);
    } catch (error) {
      await this.cancelRow(id);
      throw error;
    }
    await deps.trail.record(deps.owner, deps.sessionId, {
      kind: 'action_proposed',
      domain: draft.domain,
      tool: draft.tool,
      argsSummary: summarizeArgs(preview.args),
      outcome: 'ok',
      isWrite: true,
      confirmed: false,
    });
    return { actionId: id.toHexString(), origin, expiresAt: expiresAt.toISOString() };
  }

  private async cancelRow(id: Types.ObjectId): Promise<void> {
    try {
      await this.deps.actions.updateOne(
        this.deps.owner,
        { _id: id, status: 'pending' },
        { $set: { status: 'cancelled' } },
      );
    } catch {}
  }

  planBlock(): BlockDraft | null {
    if (this.planId === null || this.entries.length < 2) return null;
    return {
      kind: 'plan',
      planId: this.planId,
      title: `${this.entries.length} steps`,
      steps: this.entries.map((entry) => ({
        actionId: entry.id.toHexString(),
        step: entry.step,
        title: entry.title,
        status: 'pending',
      })),
    };
  }

  async cancelPending(): Promise<void> {
    await this.deps.actions.updateMany(
      this.deps.owner,
      { messageId: this.deps.messageId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
  }
}
