import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ModelMessage } from 'ai';
import { Types } from 'mongoose';
import type { Principal } from '../auth/principal.js';
import { errors } from '../common/errors.js';
import { toObjectId } from '../database/object-id.js';
import { AiAuditTrail } from './ai-audit-trail.js';
import { AiGate } from './ai-gate.js';
import { AiProvider } from './ai-provider.js';
import { AI_SETTINGS, type AiSettings } from './ai-settings.js';
import type { ChatBody } from './ai.dto.js';
import { contextOfStored, resolveContext } from './context.js';
import {
  AiActionsRepository,
  AiMessagesRepository,
  AiSessionsRepository,
} from './data/ai-data.repositories.js';
import type { AiMessageDocument } from './data/ai-message.schema.js';
import type { Owner } from './data/ai-owned.repository.js';
import { MAX_SESSION_MESSAGES, type AiSessionDocument } from './data/ai-session.schema.js';
import { AiUsageService, usageDayOf } from './data/ai-usage.service.js';
import { PrincipalRefresher } from './principal-refresh.js';
import { schemaSummaryOf } from './schema-summary.js';
import { ownerOf } from './sessions.service.js';
import { TOOL_SERVICES } from './tool-services.js';
import type { ToolServices } from './tools/tool.js';
import { Turn } from './turn.js';

export const HISTORY_CHARS = 24000;
const TITLE_CHARS = 80;
export const LEASE_SETTLE_MARGIN_MS = 30_000;

interface Lease {
  session: AiSessionDocument;
  created: boolean;
}

export function titleOf(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= TITLE_CHARS ? flat : `${flat.slice(0, TITLE_CHARS - 1)}…`;
}

export function historyOf(
  messages: Pick<AiMessageDocument, 'role' | 'text'>[],
  maxTurns: number,
): ModelMessage[] {
  if (maxTurns <= 0) return [];
  const recent = messages.filter((message) => message.text.trim() !== '').slice(-2 * maxTurns);
  const kept: ModelMessage[] = [];
  let chars = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    chars += message.text.length;
    if (chars > HISTORY_CHARS) break;
    kept.unshift({ role: message.role, content: message.text });
  }
  return kept;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger('AiChat');

  constructor(
    private readonly gate: AiGate,
    private readonly provider: AiProvider,
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
    @Inject(TOOL_SERVICES) private readonly services: ToolServices,
    private readonly sessions: AiSessionsRepository,
    private readonly messages: AiMessagesRepository,
    private readonly actions: AiActionsRepository,
    private readonly usage: AiUsageService,
    private readonly refresher: PrincipalRefresher,
    private readonly trail: AiAuditTrail,
  ) {}

  async begin(principal: Principal, body: ChatBody, authenticatedAt: Date): Promise<Turn> {
    this.gate.assertEnabled(principal);
    this.gate.assertMessageLength(body.message);
    await this.gate.assertRate(principal);
    const owner = ownerOf(principal);
    const turnId = randomUUID();
    const deadline = new Date(Date.now() + this.settings.limits.requestTimeoutMs);
    const day = usageDayOf();
    const lease = await this.claimLease(owner, body, turnId, deadline);
    let counted = false;
    try {
      await this.gate.assertInFlight(owner);
      await this.gate.claimDailyTurn(principal, day);
      counted = true;
      return await this.prepare(principal, body, lease, { turnId, authenticatedAt, deadline, day });
    } catch (error) {
      if (counted) await this.gate.releaseDailyTurn(principal, day).catch(() => undefined);
      await this.releaseLease(owner, lease, turnId).catch(() => undefined);
      throw error;
    }
  }

  private async claimLease(
    owner: Owner,
    body: ChatBody,
    turnId: string,
    deadline: Date,
  ): Promise<Lease> {
    const now = new Date();
    const turnLeaseUntil = new Date(deadline.getTime() + LEASE_SETTLE_MARGIN_MS);
    if (body.sessionId === null) {
      if (body.mode === 'regenerate') throw nothingToRegenerate();
      const session = await this.sessions.create(owner, {
        title: titleOf(body.message),
        messageCount: 0,
        lastMessageAt: now,
        turnId,
        turnLeaseUntil,
      });
      return { session, created: true };
    }
    const rowsAdded = body.mode === 'send' ? 2 : 1;
    const claimed = await this.sessions.updateOne(
      owner,
      {
        _id: toObjectId(body.sessionId),
        messageCount: { $lte: MAX_SESSION_MESSAGES - rowsAdded },
        $or: [{ turnLeaseUntil: null }, { turnLeaseUntil: { $lte: now } }],
      },
      { $set: { turnId, turnLeaseUntil } },
    );
    if (claimed) return { session: claimed, created: false };
    const current = await this.sessions.findById(owner, body.sessionId);
    if (!current) throw errors.notFound('Session');
    if (current.messageCount > MAX_SESSION_MESSAGES - rowsAdded) {
      throw errors.conflict('AI_SESSION_FULL', 'This chat is full; start a new chat');
    }
    throw turnInProgress();
  }

  private async releaseLease(owner: Owner, lease: Lease, turnId: string): Promise<void> {
    if (lease.created) {
      await this.sessions.deleteMany(owner, { _id: lease.session._id });
      return;
    }
    await this.sessions.updateOne(
      owner,
      { _id: lease.session._id, turnId },
      { $set: { turnId: null, turnLeaseUntil: null } },
    );
  }

  private async prepare(
    principal: Principal,
    body: ChatBody,
    lease: Lease,
    turn: { turnId: string; authenticatedAt: Date; deadline: Date; day: string },
  ): Promise<Turn> {
    const { turnId, authenticatedAt, deadline, day } = turn;
    const owner = ownerOf(principal);
    const sessionId = lease.session._id;
    let previous: AiMessageDocument | null = null;
    if (body.mode === 'regenerate') {
      [previous = null] = await this.messages.find(
        owner,
        { sessionId, role: 'user', regenerated: false },
        { sort: { _id: -1 }, limit: 1 },
      );
      if (!previous) throw nothingToRegenerate();
    }
    const userText = previous ? previous.text : body.message;

    const resolved = await resolveContext(
      this.services,
      principal,
      previous ? contextOfStored(previous.context) : body.context,
    );

    let userMessage: AiMessageDocument;
    if (previous) {
      userMessage = previous;
    } else {
      userMessage = await this.messages.create(owner, {
        sessionId,
        role: 'user',
        text: userText,
        blocks: [],
        toolTrace: [],
        status: 'complete',
        errorCode: null,
        stopped: false,
        regenerated: false,
        kind: 'answer',
        context: resolved.stored,
      });
      await this.sessions.updateOne(
        owner,
        { _id: sessionId },
        { $inc: { messageCount: 1 }, $set: { lastMessageAt: new Date() } },
      );
    }

    const maxTurns = this.settings.limits.maxHistoryTurns;
    const earlier =
      maxTurns > 0
        ? await this.messages.find(
            owner,
            { sessionId, regenerated: false, _id: { $lt: userMessage._id } },
            { sort: { _id: -1 }, limit: 2 * maxTurns },
          )
        : [];
    const types = await this.services.contentTypes
      .list(principal, { status: 'active' })
      .catch(() => []);

    if (lease.created) {
      await this.trail.record(owner, sessionId.toHexString(), {
        kind: 'session_created',
        outcome: 'ok',
      });
    }
    await this.trail.record(owner, sessionId.toHexString(), {
      kind: 'message',
      outcome: 'ok',
      argsSummary: {
        role: 'user',
        length: userText.length,
        mode: body.mode,
        selectedRecords: resolved.stored.selectedRecordIds.length,
      },
    });

    const prepared = new Turn(
      {
        provider: this.provider,
        settings: this.settings,
        services: this.services,
        refresher: this.refresher,
        trail: this.trail,
        sessions: this.sessions,
        messages: this.messages,
        actions: this.actions,
        usage: this.usage,
        logger: this.logger,
      },
      {
        principal,
        authenticatedAt,
        deadline,
        usageDay: day,
        sessionId: sessionId.toHexString(),
        turnId,
        userMessageId: userMessage._id.toHexString(),
        assistantMessageId: new Types.ObjectId(),
        regenerate: body.mode === 'regenerate',
        history: historyOf(earlier.reverse(), maxTurns),
        userText,
        context: resolved.prompt,
        schemaSummary: schemaSummaryOf(types),
      },
    );
    if (previous) await this.replaceAnswersTo(owner, previous);
    return prepared;
  }

  private async replaceAnswersTo(owner: Owner, userMessage: AiMessageDocument): Promise<void> {
    const answers = await this.messages.find(owner, {
      sessionId: userMessage.sessionId,
      role: 'assistant',
      regenerated: false,
      kind: 'answer',
      _id: { $gt: userMessage._id },
    });
    if (answers.length === 0) return;
    const ids = answers.map((answer) => answer._id);
    await this.messages.updateMany(owner, { _id: { $in: ids } }, { $set: { regenerated: true } });
    await this.actions.updateMany(
      owner,
      { messageId: { $in: ids }, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
  }
}

function nothingToRegenerate() {
  return errors.conflict('AI_NOTHING_TO_REGENERATE', 'There is no message to answer again');
}

function turnInProgress() {
  return errors.conflict(
    'AI_TURN_IN_PROGRESS',
    'Another answer is still being written; wait for it or stop it',
  );
}
