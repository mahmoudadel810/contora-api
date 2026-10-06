import { Injectable } from '@nestjs/common';
import { AiUsageRepository } from './ai-data.repositories.js';
import type { AiUsageKind } from './ai-usage-daily.schema.js';

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
}

export function usageDayOf(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function secondsUntilNextDay(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

@Injectable()
export class AiUsageService {
  constructor(private readonly usage: AiUsageRepository) {}

  claim(
    tenantId: string,
    userId: string | null,
    kind: AiUsageKind,
    limit: number,
    day: string = usageDayOf(),
  ) {
    return this.usage.countBelow({ tenantId, userId, kind, day }, limit);
  }

  unclaim(
    tenantId: string,
    userId: string | null,
    kind: AiUsageKind,
    day: string = usageDayOf(),
  ): Promise<void> {
    return this.usage.uncount({ tenantId, userId, kind, day });
  }

  recordTokens(
    tenantId: string,
    userId: string | null,
    kind: AiUsageKind,
    tokens: TokenCounts,
    day: string = usageDayOf(),
  ): Promise<void> {
    return this.usage.addTokens({ tenantId, userId, kind, day }, tokens);
  }
}
