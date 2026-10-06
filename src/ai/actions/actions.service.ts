import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Types } from 'mongoose';
import { AuditService } from '../../audit/audit.service.js';
import { actorOf, type Principal } from '../../auth/principal.js';
import { can } from '../../authorization/policy.js';
import { toErrorBody } from '../../common/app-exception.filter.js';
import { AppError, errors } from '../../common/errors.js';
import { parseWith } from '../../common/zod.pipe.js';
import { isObjectId, toObjectId } from '../../database/object-id.js';
import type { UploadedFile } from '../../storage/blobs.service.js';
import { AiAuditTrail } from '../ai-audit-trail.js';
import { summarizeArgs } from '../args-summary.js';
import {
  AiActionsRepository,
  AiMessagesRepository,
  AiSessionsRepository,
} from '../data/ai-data.repositories.js';
import type { Owner } from '../data/ai-owned.repository.js';
import type { AiPendingActionDocument } from '../data/ai-pending-action.schema.js';
import { redactProviderError } from '../redact-provider-error.js';
import { MAX_RECHECKED, ownerOf } from '../sessions.service.js';
import { TOOL_SERVICES } from '../tool-services.js';
import { PROPOSALS_BY_TOOL } from '../tools/domains.js';
import { ActionBaseSchema, type Executed } from '../tools/proposal.js';
import type { ToolServices } from '../tools/tool.js';
import { reducedActionView, toActionView, type ActionView } from './action-view.js';

export interface ConfirmInput {
  acknowledgeDestructive: boolean;
  file: UploadedFile | null;
}

const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.CONFLICT, code, message, details);

function refsOf(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .filter(([key, value]) => key.endsWith('Ref') && typeof value === 'string')
    .map(([, value]) => value as string);
}

@Injectable()
export class ActionsService {
  private readonly logger = new Logger('AiActions');

  constructor(
    private readonly actions: AiActionsRepository,
    private readonly sessions: AiSessionsRepository,
    private readonly messages: AiMessagesRepository,
    private readonly audit: AuditService,
    private readonly trail: AiAuditTrail,
    @Inject(TOOL_SERVICES) private readonly services: ToolServices,
  ) {}

  async confirm(
    principal: Principal,
    id: string,
    input: ConfirmInput,
  ): Promise<{ action: ActionView }> {
    const owner = ownerOf(principal);
    const action = await this.actions.findById(owner, id);
    if (!action) throw errors.notFound('Action');
    if (action.status !== 'pending' || action.expiresAt.getTime() <= Date.now()) {
      throw await this.claimRefusal(principal, action._id);
    }
    if (action.needsFile && !input.file) {
      throw conflict('FILE_REQUIRED', 'Choose the file on the card, then confirm');
    }
    if (action.destructive && !input.acknowledgeDestructive) {
      throw conflict('CONFIRMATION_REQUIRED', 'Confirm this deletion explicitly');
    }
    const proposal = PROPOSALS_BY_TOOL.get(action.tool);
    if (!proposal) {
      throw conflict('ACTION_UNSUPPORTED', 'This card can no longer be confirmed; ask again');
    }
    const resolved = await this.dependencies(owner, action);

    const now = new Date();
    const claimed = await this.actions.updateOne(
      owner,
      { _id: action._id, status: 'pending', expiresAt: { $gt: now } },
      { $set: { status: 'executing', executingSince: now } },
    );
    if (!claimed) throw await this.claimRefusal(principal, action._id);

    const started = Date.now();
    let executed: Executed;
    try {
      const args = parseWith(proposal.stored, claimed.args);
      const base = claimed.base ? parseWith(ActionBaseSchema, claimed.base) : null;
      executed = await proposal.execute(
        {
          principal,
          services: this.services,
          file: action.needsFile ? input.file : null,
          resolved: (ref) => {
            const created = resolved.get(ref);
            if (!created) {
              throw conflict(
                'ACTION_DEPENDENCY_FAILED',
                'An earlier step of this plan did not run',
              );
            }
            return created;
          },
        },
        args,
        base,
      );
    } catch (error) {
      await this.markFailed(owner, claimed, error, Date.now() - started);
      throw error;
    }

    const sessionId = claimed.sessionId.toHexString();
    const doneView: ActionView = {
      ...toActionView(claimed),
      status: executed.status,
      result: executed.result as unknown as Record<string, unknown>,
      errorCode: null,
    };
    try {
      const done = await this.actions.updateOne(
        owner,
        { _id: claimed._id, status: 'executing' },
        {
          $set: {
            status: executed.status,
            result: executed.result as unknown as Record<string, unknown>,
            errorCode: null,
            executedAt: new Date(),
          },
        },
      );
      if (executed.resource) {
        await this.audit.record(principal.tenantId, {
          action: 'AI_ACTION_CONFIRMED',
          actor: actorOf(principal),
          resource: executed.resource,
          context: {
            tool: claimed.tool,
            actionId: claimed.id as string,
            sessionId,
            ...executed.auditContext,
          },
        });
      }
      if (done) Object.assign(doneView, toActionView(done));
    } catch (error) {
      this.logger.error(
        `A confirmed AI action ran, but its bookkeeping failed: ${redactProviderError(error).name}`,
      );
    }
    await this.trail.record(owner, sessionId, {
      kind: 'action_confirmed',
      domain: claimed.domain,
      tool: claimed.tool,
      argsSummary: summarizeArgs(claimed.args),
      outcome: 'ok',
      durationMs: Date.now() - started,
      isWrite: true,
      confirmed: true,
    });
    await this.appendNote(owner, claimed.sessionId, executed.note);
    return { action: doneView };
  }

  async cancel(principal: Principal, id: string): Promise<{ action: ActionView }> {
    const owner = ownerOf(principal);
    const action = await this.actions.findById(owner, id);
    if (!action) throw errors.notFound('Action');
    const cancelled = await this.actions.updateOne(
      owner,
      { _id: action._id, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
    if (!cancelled) {
      const current = await this.actions.findById(owner, id);
      if (!current) throw errors.notFound('Action');
      throw notPending(await this.viewFor(principal, current));
    }
    await this.trail.record(owner, cancelled.sessionId.toHexString(), {
      kind: 'action_cancelled',
      domain: cancelled.domain,
      tool: cancelled.tool,
      outcome: 'ok',
      isWrite: true,
      confirmed: false,
    });
    return { action: await this.viewFor(principal, cancelled) };
  }

  private async dependencies(
    owner: Owner,
    action: AiPendingActionDocument,
  ): Promise<Map<string, string>> {
    const refs = new Set(refsOf(action.args));
    if (action.dependsOn) refs.add(action.dependsOn.toHexString());
    const resolved = new Map<string, string>();
    const now = Date.now();
    for (const ref of refs) {
      const dependency =
        action.planId !== null && action.step !== null && isObjectId(ref)
          ? await this.actions.findOne(owner, {
              _id: toObjectId(ref),
              planId: action.planId,
              step: { $lt: action.step },
            })
          : null;
      const created = dependency?.result?.['id'];
      if (dependency?.status === 'done' && typeof created === 'string') {
        resolved.set(ref, created);
        continue;
      }
      const running =
        dependency !== null &&
        (dependency.status === 'executing' ||
          (dependency.status === 'pending' && dependency.expiresAt.getTime() > now));
      throw running
        ? conflict('ACTION_DEPENDENCY_PENDING', 'Confirm the earlier step of this plan first')
        : conflict(
            'ACTION_DEPENDENCY_FAILED',
            'An earlier step of this plan did not run; ask again',
          );
    }
    return resolved;
  }

  private async claimRefusal(principal: Principal, id: Types.ObjectId): Promise<AppError> {
    const owner = ownerOf(principal);
    const current = await this.actions.findById(owner, id.toHexString());
    if (!current) return errors.notFound('Action');
    const now = new Date();
    if (current.status === 'pending' && current.expiresAt.getTime() <= now.getTime()) {
      await this.actions.updateOne(
        owner,
        { _id: current._id, status: 'pending', expiresAt: { $lte: now } },
        { $set: { status: 'expired' } },
      );
      return conflict('ACTION_EXPIRED', 'This card expired — ask again');
    }
    if (current.status === 'expired')
      return conflict('ACTION_EXPIRED', 'This card expired — ask again');
    return notPending(await this.viewFor(principal, current));
  }

  private async viewFor(
    principal: Principal,
    action: AiPendingActionDocument,
  ): Promise<ActionView> {
    const view = toActionView(action);
    if (action.domain === 'admin' && !can(principal, 'admin.overview')) {
      return reducedActionView(view);
    }
    const lookups = [
      ...action.targets.records.map((id) => ({ kind: 'record' as const, id })),
      ...action.targets.folders.map((id) => ({ kind: 'folder' as const, id })),
    ];
    if (lookups.length > MAX_RECHECKED) return reducedActionView(view);
    const { access } = this.services;
    for (const { kind, id } of lookups) {
      const lookup: Promise<unknown> =
        kind === 'record'
          ? access.requireRecord(principal, id, 'view')
          : access.requireFolder(principal, id, 'view');
      const visible = await lookup.then(
        () => true,
        () => false,
      );
      if (!visible) return reducedActionView(view);
    }
    return view;
  }

  private async markFailed(
    owner: Owner,
    action: AiPendingActionDocument,
    error: unknown,
    durationMs: number,
  ): Promise<void> {
    const known = error instanceof HttpException;
    const errorCode = known ? toErrorBody(error).code : 'INTERNAL_ERROR';
    if (!known) {
      this.logger.error(`An AI action failed unexpectedly: ${redactProviderError(error).name}`);
    }
    try {
      await this.actions.updateOne(
        owner,
        { _id: action._id, status: 'executing' },
        { $set: { status: 'failed', errorCode, executedAt: new Date() } },
      );
    } catch (writeError) {
      this.logger.error(
        `Could not mark an AI action failed: ${redactProviderError(writeError).name}`,
      );
    }
    await this.trail.record(owner, action.sessionId.toHexString(), {
      kind: 'action_failed',
      domain: action.domain,
      tool: action.tool,
      argsSummary: summarizeArgs(action.args),
      outcome: known ? 'refused' : 'error',
      errorCode,
      durationMs,
      isWrite: true,
      confirmed: true,
    });
  }

  private async appendNote(owner: Owner, sessionId: Types.ObjectId, text: string): Promise<void> {
    try {
      const session = await this.sessions.updateOne(
        owner,
        { _id: sessionId },
        { $inc: { messageCount: 1 }, $set: { lastMessageAt: new Date() } },
      );
      if (!session) return;
      await this.messages.create(owner, {
        sessionId,
        role: 'assistant',
        text,
        blocks: [],
        toolTrace: [],
        status: 'complete',
        errorCode: null,
        stopped: false,
        regenerated: false,
        kind: 'note',
        context: null,
      });
    } catch (error) {
      this.logger.warn(`Could not add a confirm note: ${redactProviderError(error).name}`);
    }
  }
}

function notPending(action: ActionView): AppError {
  return conflict('ACTION_NOT_PENDING', 'This card was already handled', { action });
}
