import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Principal } from '../auth/principal.js';
import { AppError, errors } from '../common/errors.js';
import { AiAvailability } from './ai-availability.js';

import { AI_SETTINGS, type AiSettings } from './ai-settings.js';
import { AiSessionsRepository } from './data/ai-data.repositories.js';
import type { Owner } from './data/ai-owned.repository.js';
import { AiUsageService, secondsUntilNextDay } from './data/ai-usage.service.js';

export const MAX_TURNS_IN_FLIGHT = 2;
const RATE_WINDOW_MS = 60_000;
const THROTTLER_NAME = 'ai';

const limited = (code: string, message: string, retryAfterSeconds: number) =>
  new AppError(HttpStatus.TOO_MANY_REQUESTS, code, message, { retryAfterSeconds });

@Injectable()
export class AiGate {
  constructor(
    private readonly availability: AiAvailability,
    @Inject(ThrottlerStorage) private readonly throttler: ThrottlerStorage,
    private readonly usage: AiUsageService,
    private readonly sessions: AiSessionsRepository,
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
  ) {}

  assertEnabled(principal: Principal): void {
    this.availability.assertAiAvailable(principal);
  }

  assertMessageLength(message: string): void {
    const max = this.settings.limits.maxInputChars;
    if (message.length > max) {
      throw errors.validation([{ path: 'message', message: `At most ${max} characters` }]);
    }
  }

  async assertRate(principal: Principal): Promise<void> {
    const record = await this.throttler.increment(
      `ai:${principal.tenantId}:${principal.userId}`,
      RATE_WINDOW_MS,
      this.settings.limits.userRatePerMinute,
      0,
      THROTTLER_NAME,
    );
    if (record.isBlocked) {
      throw limited(
        'AI_RATE_LIMITED',
        'Too many messages; please wait a moment and try again',
        Math.max(1, record.timeToBlockExpire),
      );
    }
  }

  async assertInFlight(owner: Owner): Promise<void> {
    const inFlight = await this.sessions.count(owner, { turnLeaseUntil: { $gt: new Date() } });
    if (inFlight > MAX_TURNS_IN_FLIGHT) {
      throw errors.conflict(
        'AI_TURN_IN_PROGRESS',
        'Another answer is still being written; wait for it or stop it',
      );
    }
  }

  async claimDailyTurn(principal: Principal, day: string): Promise<void> {
    const { tenantDailyTurns, userDailyTurns } = this.settings.limits;
    if (!(await this.usage.claim(principal.tenantId, null, 'chat', tenantDailyTurns, day))) {
      throw limited(
        'AI_TENANT_LIMIT',
        'This workspace has used its assistant turns for today',
        secondsUntilNextDay(),
      );
    }
    if (
      !(await this.usage.claim(principal.tenantId, principal.userId, 'chat', userDailyTurns, day))
    ) {
      await this.usage.unclaim(principal.tenantId, null, 'chat', day);
      throw limited(
        'AI_USER_LIMIT',
        'You have used your assistant turns for today',
        secondsUntilNextDay(),
      );
    }
  }

  async releaseDailyTurn(principal: Principal, day: string): Promise<void> {
    await this.usage.unclaim(principal.tenantId, null, 'chat', day);
    await this.usage.unclaim(principal.tenantId, principal.userId, 'chat', day);
  }
}
