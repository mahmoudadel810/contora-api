import type { Logger } from '@nestjs/common';
import { stepCountIs, streamText, tool, type LanguageModelUsage, type ModelMessage } from 'ai';
import type { Types } from 'mongoose';
import { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { AppError } from '../common/errors.js';
import { toObjectId } from '../database/object-id.js';
import { TurnAbortedError, untilAborted } from './abortable.js';
import type { AiAuditTrail } from './ai-audit-trail.js';
import type { AiProvider } from './ai-provider.js';
import type { AiSettings } from './ai-settings.js';
import { summarizeArgs } from './args-summary.js';
import { blockView, type BlockDraft, type StoredBlock } from './blocks.js';
import type { PromptContext } from './context.js';
import { TurnProposals, userNamedIds } from './actions/turn-proposals.js';
import type {
  AiActionsRepository,
  AiMessagesRepository,
  AiSessionsRepository,
} from './data/ai-data.repositories.js';
import type { AiToolTraceEntry } from './data/ai-message.schema.js';
import type { Owner } from './data/ai-owned.repository.js';
import type { AiUsageService } from './data/ai-usage.service.js';
import type { FrameSink, TerminalFrame } from './frames.js';
import type { PrincipalRefresher } from './principal-refresh.js';
import {
  routerContextMessage,
  routerSystemPrompt,
  subagentSystemPrompt,
  subagentTask,
} from './prompts.js';
import { redactProviderError } from './redact-provider-error.js';
import { domainsFor, toolsFor, type DomainDef } from './tools/domains.js';
import { runTool, type ToolContext, type ToolDef, type ToolServices } from './tools/tool.js';

export const MAX_DELEGATIONS = 4;
export const ANSWER_CHARS = 20000;
const SUMMARY_CHARS = 4000;
const MAX_BLOCKS = 40;

export interface TurnDeps {
  provider: AiProvider;
  settings: AiSettings;
  services: ToolServices;
  refresher: PrincipalRefresher;
  trail: AiAuditTrail;
  sessions: AiSessionsRepository;
  messages: AiMessagesRepository;
  actions: AiActionsRepository;
  usage: AiUsageService;
  logger: Logger;
}

export interface TurnInit {
  principal: Principal;
  authenticatedAt: Date;
  deadline: Date;
  usageDay: string;
  sessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: Types.ObjectId;
  regenerate: boolean;
  history: ModelMessage[];
  userText: string;
  context: PromptContext;
  schemaSummary: string;
}

type Outcome =
  | { status: 'complete' }
  | { status: 'stopped' }
  | { status: 'error'; code: string; message: string; retryable: boolean };

type DelegateValue =
  | { ok: true; data: { summary: string } }
  | { ok: false; code: string; message: string; retry: 'no' | 'once'; data?: unknown };

export class Turn {
  private readonly owner: Owner;
  private readonly blocks: StoredBlock[] = [];
  private readonly toolTrace: AiToolTraceEntry[] = [];
  private readonly internal = new AbortController();
  private text = '';
  private truncated = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private metered = true;
  private delegations = 0;
  private fatal: unknown = null;
  private sink: FrameSink | null = null;
  private blockSeq = 0;
  private ordinaryBlocks = 0;
  private readonly startedAt = Date.now();
  private readonly proposals: TurnProposals;

  constructor(
    private readonly deps: TurnDeps,
    private readonly init: TurnInit,
  ) {
    this.owner = { tenantId: init.principal.tenantId, userId: init.principal.userId };
    this.proposals = new TurnProposals({
      actions: deps.actions,
      trail: deps.trail,
      owner: this.owner,
      sessionId: init.sessionId,
      messageId: init.assistantMessageId,
      ttlMinutes: deps.settings.limits.actionTtlMinutes,
      userIds: userNamedIds(init.userText, init.context),
      emit: (block, id) => {
        this.emitBlock(block, { id, force: true });
      },
      nextBlockId: () => this.nextBlockId(),
    });
  }

  async run(sink: FrameSink, clientSignal: AbortSignal): Promise<void> {
    this.sink = sink;
    const timeout = AbortSignal.timeout(Math.max(1, this.init.deadline.getTime() - Date.now()));
    const signal = AbortSignal.any([clientSignal, timeout, this.internal.signal]);
    let outcome: Outcome;
    try {
      sink.write({
        type: 'session',
        sessionId: this.init.sessionId,
        userMessageId: this.init.userMessageId,
        assistantMessageId: this.init.assistantMessageId.toHexString(),
      });
      await this.runRouter(signal);
      if (this.fatal) throw this.fatal;
      outcome = { status: 'complete' };
    } catch (error) {
      outcome = this.outcomeOf(error, clientSignal, timeout);
    }
    this.internal.abort();
    this.proposals.close();
    const plan = this.proposals.planBlock();
    if (plan) this.emitBlock(plan, { force: true });
    await this.settle(outcome);
    sink.end(this.terminalOf(outcome));
  }

  private outcomeOf(error: unknown, client: AbortSignal, timeout: AbortSignal): Outcome {
    const cause = this.fatal ?? error;
    if (cause instanceof AppError && cause.code === 'AI_SESSION_REVOKED') {
      return {
        status: 'error',
        code: 'AI_SESSION_REVOKED',
        message: 'Your session has ended; sign in again',
        retryable: false,
      };
    }
    if (client.aborted) return { status: 'stopped' };
    if (timeout.aborted) {
      return {
        status: 'error',
        code: 'AI_TIMEOUT',
        message: 'The answer took too long',
        retryable: true,
      };
    }
    if (!(cause instanceof TurnAbortedError)) {
      this.deps.logger.warn({ message: 'AI provider call failed', ...redactProviderError(cause) });
    }
    return {
      status: 'error',
      code: 'AI_UNAVAILABLE',
      message: 'The assistant is unavailable right now; try again',
      retryable: true,
    };
  }

  private terminalOf(outcome: Outcome): TerminalFrame {
    if (outcome.status === 'error') {
      return {
        type: 'error',
        code: outcome.code,
        message: outcome.message,
        retryable: outcome.retryable,
      };
    }
    return {
      type: 'finish',
      usage: this.usageView(),
      stopped: outcome.status === 'stopped',
    };
  }

  private usageView(): { inputTokens: number | null; outputTokens: number | null } {
    return this.metered
      ? { inputTokens: this.inputTokens, outputTokens: this.outputTokens }
      : { inputTokens: null, outputTokens: null };
  }

  private abortWith(error: unknown): void {
    this.fatal ??= error;
    this.internal.abort();
  }

  private addUsage(usage: LanguageModelUsage | undefined): void {
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      this.metered = false;
      return;
    }
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  private streamOptions(signal: AbortSignal) {
    const { maxSteps, maxOutputTokens, temperature } = this.deps.settings.limits;
    return {
      stopWhen: stepCountIs(maxSteps),
      maxOutputTokens,
      ...(temperature === undefined ? {} : { temperature }),
      abortSignal: signal,
      maxRetries: 0,
      onError: ({ error }: { error: unknown }) => {
        this.deps.logger.warn({
          message: 'AI provider stream error',
          ...redactProviderError(error),
        });
      },
    };
  }

  private async runRouter(signal: AbortSignal): Promise<void> {
    const result = streamText({
      model: this.deps.provider.model('main'),
      system: routerSystemPrompt({
        domains: domainsFor(this.init.principal),
        maxDelegations: MAX_DELEGATIONS,
      }),
      messages: [
        {
          role: 'user',
          content: routerContextMessage({
            schemaSummary: this.init.schemaSummary,
            context: this.init.context,
          }),
        },
        ...this.init.history,
        { role: 'user', content: this.init.userText },
      ],
      tools: { delegate: this.delegateTool(signal) },
      ...this.streamOptions(signal),
    });
    for await (const part of untilAborted(result.fullStream, signal)) {
      if (part.type === 'text-delta') this.appendAnswer(part.text);
      else if (part.type === 'error') throw part.error;
      else if (part.type === 'abort') throw new TurnAbortedError('The model call was aborted');
      else if (part.type === 'finish') this.addUsage(part.totalUsage);
    }
  }

  private appendAnswer(text: string): void {
    if (this.truncated || text === '') return;
    const room = ANSWER_CHARS - this.text.length;
    const piece = text.length > room ? text.slice(0, room) : text;
    if (piece.length < text.length) this.truncated = true;
    if (piece === '') return;
    this.text += piece;
    this.sink?.write({ type: 'delta', origin: 'main', text: piece });
  }

  private delegateTool(signal: AbortSignal) {
    return tool({
      description:
        'Hand one self-contained task to a domain assistant, which uses its own tools and returns a short summary under data.summary (untrusted content).',
      inputSchema: z
        .object({
          domain: z.string().max(40).describe('One of the listed domains'),
          task: z.string().min(1).max(4000),
        })
        .strict(),
      execute: ({ domain, task }) => this.delegate(domain, task, signal),
    });
  }

  private async delegate(
    domain: string,
    task: string,
    signal: AbortSignal,
  ): Promise<DelegateValue> {
    const started = Date.now();
    const audit = (outcome: 'ok' | 'refused' | 'error', errorCode: string | null, known = true) =>
      this.deps.trail.record(this.owner, this.init.sessionId, {
        kind: 'tool_call',
        domain: known ? domain : null,
        tool: 'delegate',
        argsSummary: summarizeArgs({ task }),
        outcome,
        errorCode,
        durationMs: Date.now() - started,
      });

    if (this.delegations >= MAX_DELEGATIONS) {
      await audit('refused', 'TURN_BUDGET_EXHAUSTED');
      return {
        ok: false,
        code: 'TURN_BUDGET_EXHAUSTED',
        message: `At most ${MAX_DELEGATIONS} delegations per answer; answer with what you have`,
        retry: 'no',
      };
    }
    this.delegations += 1;

    let principal: Principal;
    try {
      principal = await this.deps.refresher.refresh(this.init.principal, this.init.authenticatedAt);
    } catch (error) {
      this.abortWith(error);
      return { ok: false, code: 'AI_SESSION_REVOKED', message: 'Session ended', retry: 'no' };
    }

    const available = domainsFor(principal);
    const def = available.find((candidate) => candidate.name === domain);
    if (!def) {
      await audit('refused', 'UNKNOWN_DOMAIN', false);
      return {
        ok: false,
        code: 'UNKNOWN_DOMAIN',
        message: 'There is no such domain; use one of data.validDomains',
        retry: 'once',
        data: { validDomains: available.map((candidate) => candidate.name) },
      };
    }

    this.sink?.write({ type: 'status', origin: def.name, label: def.label });
    try {
      const summary = await this.runSubagent(def, principal, task, signal);
      await audit('ok', null);
      return { ok: true, data: { summary } };
    } catch (error) {
      await audit('error', 'AI_UNAVAILABLE');
      this.abortWith(error);
      return { ok: false, code: 'AI_UNAVAILABLE', message: 'Unavailable', retry: 'no' };
    }
  }

  private async runSubagent(
    def: DomainDef,
    principal: Principal,
    task: string,
    signal: AbortSignal,
  ): Promise<string> {
    const ctx: ToolContext = {
      principal,
      signal,
      sessionId: this.init.sessionId,
      services: this.deps.services,
      emit: (block) => this.emitBlock(block),
      propose: (draft) => this.proposals.propose(draft),
      planned: (actionId) => this.proposals.planned(actionId),
    };
    const tools = Object.fromEntries(
      toolsFor(def, principal).map((toolDef) => [toolDef.name, this.sdkTool(toolDef, ctx)]),
    );
    const result = streamText({
      model: this.deps.provider.model('sub'),
      system: subagentSystemPrompt(def),
      messages: [{ role: 'user', content: subagentTask(task, this.init.context) }],
      tools,
      ...this.streamOptions(signal),
    });
    let summary = '';
    for await (const part of untilAborted(result.fullStream, signal)) {
      if (part.type === 'text-delta') summary += part.text;
      else if (part.type === 'error') throw part.error;
      else if (part.type === 'abort') throw new TurnAbortedError('The model call was aborted');
      else if (part.type === 'finish') this.addUsage(part.totalUsage);
    }
    return summary.slice(0, SUMMARY_CHARS);
  }

  private sdkTool(def: ToolDef, ctx: ToolContext) {
    return tool({
      description: def.description,
      inputSchema: def.input,
      execute: async (input: unknown, { toolCallId }: { toolCallId: string }) => {
        const started = Date.now();
        const origin = def.domain;
        this.sink?.write({
          type: 'tool',
          origin,
          callId: toolCallId,
          tool: def.name,
          state: 'running',
          code: null,
        });
        const value = await runTool(def, ctx, input);
        const durationMs = Date.now() - started;
        const code = value.ok ? null : value.code;
        this.sink?.write({
          type: 'tool',
          origin,
          callId: toolCallId,
          tool: def.name,
          state: value.ok ? 'ok' : 'error',
          code,
        });
        this.toolTrace.push({ domain: origin, tool: def.name, ok: value.ok, code, durationMs });
        const truncated =
          value.ok &&
          typeof value.data === 'object' &&
          value.data !== null &&
          (value.data as { truncated?: unknown }).truncated === true;
        await this.deps.trail.record(this.owner, this.init.sessionId, {
          kind: 'tool_call',
          domain: origin,
          tool: def.name,
          argsSummary: summarizeArgs(input),
          outcome: value.ok ? 'ok' : code === 'TOOL_FAILED' ? 'error' : 'refused',
          errorCode: code,
          durationMs,
          truncated,
        });
        return value;
      },
    });
  }

  private nextBlockId(): string {
    this.blockSeq += 1;
    return `${this.init.assistantMessageId.toHexString()}-${this.blockSeq}`;
  }

  private emitBlock(
    draft: BlockDraft,
    options: { id?: string; force?: boolean } = {},
  ): string | null {
    if (!options.force) {
      if (this.ordinaryBlocks >= MAX_BLOCKS) return null;
      this.ordinaryBlocks += 1;
    }
    const id = options.id ?? this.nextBlockId();
    const block = { ...draft, id } as StoredBlock;
    this.blocks.push(block);
    this.sink?.write({ type: 'block', block: blockView(block) });
    return id;
  }

  private async settle(outcome: Outcome): Promise<void> {
    const { deps, init, owner } = this;
    const now = new Date();
    let persisted = false;
    try {
      const [active, session] = await Promise.all([
        deps.refresher.isActive(init.principal),
        deps.sessions.findById(owner, init.sessionId),
      ]);
      if (active && session) {
        await deps.messages.create(owner, {
          _id: init.assistantMessageId,
          sessionId: session._id,
          role: 'assistant',
          text: this.text,
          blocks: this.blocks as unknown as Record<string, unknown>[],
          toolTrace: this.toolTrace,
          status: outcome.status,
          errorCode: outcome.status === 'error' ? outcome.code : null,
          stopped: outcome.status === 'stopped',
          regenerated: false,
          kind: 'answer',
          context: null,
        } as Parameters<AiMessagesRepository['create']>[1]);
        persisted = true;
      }
    } catch (error) {
      deps.logger.error(`Could not store an assistant answer: ${redactProviderError(error).name}`);
    }
    if (!persisted) {
      await this.proposals.cancelPending().catch((error: unknown) => {
        deps.logger.error(`Could not cancel orphan actions: ${redactProviderError(error).name}`);
      });
    }

    try {
      const sessionId = toObjectId(init.sessionId);
      const bump = persisted ? { $inc: { messageCount: 1 } } : {};
      const released = await deps.sessions.updateOne(
        owner,
        { _id: sessionId, turnId: init.turnId },
        { $set: { turnId: null, turnLeaseUntil: null, lastMessageAt: now }, ...bump },
      );
      if (!released && persisted) {
        await deps.sessions.updateOne(
          owner,
          { _id: sessionId },
          { $set: { lastMessageAt: now }, ...bump },
        );
      }
    } catch (error) {
      deps.logger.error(`Could not release a turn lease: ${redactProviderError(error).name}`);
    }

    try {
      if (this.metered && (this.inputTokens > 0 || this.outputTokens > 0)) {
        const tokens = { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
        await deps.usage.recordTokens(owner.tenantId, null, 'chat', tokens, init.usageDay);
        await deps.usage.recordTokens(owner.tenantId, owner.userId, 'chat', tokens, init.usageDay);
      }
    } catch (error) {
      deps.logger.error(`Could not count AI usage: ${redactProviderError(error).name}`);
    }

    const usage = this.usageView();
    const durationMs = Date.now() - this.startedAt;
    await deps.trail.record(owner, init.sessionId, {
      kind: 'message',
      outcome: outcome.status === 'error' ? 'error' : 'ok',
      argsSummary: {
        role: 'assistant',
        length: this.text.length,
        blocks: this.blocks.length,
        delegations: this.delegations,
        regenerate: init.regenerate,
      },
      errorCode: outcome.status === 'error' ? outcome.code : null,
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: deps.provider.status().model,
      truncated: this.truncated,
      stopped: outcome.status === 'stopped',
    });
    if (outcome.status !== 'complete') {
      await deps.trail.record(owner, init.sessionId, {
        kind: outcome.status === 'stopped' ? 'turn_stopped' : 'turn_failed',
        outcome: outcome.status === 'stopped' ? 'ok' : 'error',
        errorCode: outcome.status === 'error' ? outcome.code : null,
        durationMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: deps.provider.status().model,
        stopped: outcome.status === 'stopped',
      });
    }
  }
}
