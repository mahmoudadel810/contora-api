import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiAuditEvent, AiAuditEventSchema } from './ai-audit-event.schema.js';
import {
  AiActionsRepository,
  AiEventsRepository,
  AiMessagesRepository,
  AiSessionsRepository,
  AiUsageRepository,
} from './ai-data.repositories.js';
import { AiDataService } from './ai-data.service.js';
import { AiUsageService } from './ai-usage.service.js';
import { AiMessage, AiMessageSchema } from './ai-message.schema.js';
import { AiPendingAction, AiPendingActionSchema } from './ai-pending-action.schema.js';
import { AiSession, AiSessionSchema } from './ai-session.schema.js';
import { AiUsageDaily, AiUsageDailySchema } from './ai-usage-daily.schema.js';

const REPOSITORIES = [
  AiSessionsRepository,
  AiMessagesRepository,
  AiActionsRepository,
  AiEventsRepository,
  AiUsageRepository,
];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AiSession.name, schema: AiSessionSchema },
      { name: AiMessage.name, schema: AiMessageSchema },
      { name: AiPendingAction.name, schema: AiPendingActionSchema },
      { name: AiAuditEvent.name, schema: AiAuditEventSchema },
      { name: AiUsageDaily.name, schema: AiUsageDailySchema },
    ]),
  ],
  providers: [...REPOSITORIES, AiDataService, AiUsageService],
  exports: [...REPOSITORIES, AiDataService, AiUsageService],
})
export class AiDataModule {}
