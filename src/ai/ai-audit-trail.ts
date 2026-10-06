import { Injectable, Logger } from '@nestjs/common';
import { toObjectId } from '../database/object-id.js';
import type { AiEventKind, AiEventOutcome } from './data/ai-audit-event.schema.js';
import { AiEventsRepository } from './data/ai-data.repositories.js';
import type { Owner } from './data/ai-owned.repository.js';

export interface AiEventInput {
  kind: AiEventKind;
  outcome: AiEventOutcome;
  domain?: string | null;
  tool?: string | null;
  argsSummary?: Record<string, unknown> | null;
  errorCode?: string | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string | null;
  isWrite?: boolean;
  confirmed?: boolean;
  truncated?: boolean;
  stopped?: boolean;
}

@Injectable()
export class AiAuditTrail {
  private readonly logger = new Logger('AiAudit');

  constructor(private readonly events: AiEventsRepository) {}

  async record(owner: Owner, sessionId: string, event: AiEventInput): Promise<void> {
    try {
      await this.events.create(owner.tenantId, {
        sessionId: toObjectId(sessionId),
        userId: toObjectId(owner.userId),
        timestamp: new Date(),
        kind: event.kind,
        outcome: event.outcome,
        domain: event.domain ?? null,
        tool: event.tool ?? null,
        argsSummary: event.argsSummary ?? null,
        errorCode: event.errorCode ?? null,
        durationMs: event.durationMs ?? null,
        inputTokens: event.inputTokens ?? null,
        outputTokens: event.outputTokens ?? null,
        model: event.model ?? null,
        isWrite: event.isWrite ?? false,
        confirmed: event.confirmed ?? false,
        truncated: event.truncated ?? false,
        stopped: event.stopped ?? false,
      });
    } catch (error) {
      this.logger.error(
        `Could not write an AI audit event (${event.kind}): ${error instanceof Error ? error.name : 'Unknown'}`,
      );
    }
  }
}
