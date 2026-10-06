import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { isDuplicateKey } from '../../common/duplicate-key.js';
import { toObjectId } from '../../database/object-id.js';
import { TenantRepository } from '../../database/tenant.repository.js';
import { AiAuditEvent } from './ai-audit-event.schema.js';
import { AiMessage } from './ai-message.schema.js';
import { AiOwnedRepository } from './ai-owned.repository.js';
import { AiPendingAction } from './ai-pending-action.schema.js';
import { AiSession } from './ai-session.schema.js';
import { AiUsageDaily, type AiUsageKind } from './ai-usage-daily.schema.js';

@Injectable()
export class AiSessionsRepository extends AiOwnedRepository<AiSession> {
  constructor(@InjectModel(AiSession.name) model: Model<AiSession>) {
    super(model);
  }
}

@Injectable()
export class AiMessagesRepository extends AiOwnedRepository<AiMessage> {
  constructor(@InjectModel(AiMessage.name) model: Model<AiMessage>) {
    super(model);
  }
}

@Injectable()
export class AiActionsRepository extends AiOwnedRepository<AiPendingAction> {
  constructor(@InjectModel(AiPendingAction.name) model: Model<AiPendingAction>) {
    super(model);
  }
}

@Injectable()
export class AiEventsRepository extends TenantRepository<AiAuditEvent> {
  constructor(@InjectModel(AiAuditEvent.name) model: Model<AiAuditEvent>) {
    super(model);
  }
}

export interface UsageKey {
  tenantId: string;
  userId: string | null;
  kind: AiUsageKind;
  day: string;
}

@Injectable()
export class AiUsageRepository extends TenantRepository<AiUsageDaily> {
  constructor(@InjectModel(AiUsageDaily.name) model: Model<AiUsageDaily>) {
    super(model);
  }

  private rowOf(key: UsageKey) {
    return { userId: key.userId ? toObjectId(key.userId) : null, kind: key.kind, day: key.day };
  }

  async countBelow(key: UsageKey, limit: number): Promise<boolean> {
    if (limit <= 0) return false;
    const filter = this.scope(key.tenantId, { ...this.rowOf(key), turns: { $lt: limit } });
    try {
      await this.model
        .updateOne(
          filter,
          { $inc: { turns: 1 }, $setOnInsert: { inputTokens: 0, outputTokens: 0 } },
          { upsert: true },
        )
        .exec();
      return true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    const retry = await this.model.updateOne(filter, { $inc: { turns: 1 } }).exec();
    return retry.modifiedCount === 1;
  }

  async uncount(key: UsageKey): Promise<void> {
    await this.updateMany(
      key.tenantId,
      { ...this.rowOf(key), turns: { $gt: 0 } },
      { $inc: { turns: -1 } },
    );
  }

  async addTokens(
    key: UsageKey,
    tokens: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    await this.updateMany(key.tenantId, this.rowOf(key), {
      $inc: { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens },
    });
  }
}
