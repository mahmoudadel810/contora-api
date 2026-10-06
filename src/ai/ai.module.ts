import { Module, type OnModuleInit } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AdminModule } from '../admin/admin.module.js';
import { BulkModule } from '../bulk/bulk.module.js';
import { CommentsModule } from '../comments/comments.module.js';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { FoldersModule } from '../folders/folders.module.js';
import { MembersModule } from '../members/members.module.js';
import { MyRecordsModule } from '../my-records/my-records.module.js';
import { RecordsModule } from '../records/records.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { SavedSearchesModule } from '../saved-searches/saved-searches.module.js';
import { TrashModule } from '../trash/trash.module.js';
import { ActionsService } from './actions/actions.service.js';
import { AiAuditTrail } from './ai-audit-trail.js';
import { AiCoreModule } from './ai-core.module.js';
import { AiEnabledGuard } from './ai-enabled.guard.js';
import { AiGate } from './ai-gate.js';
import { AiController } from './ai.controller.js';
import { ChatService } from './chat.service.js';
import { PrincipalRefresher } from './principal-refresh.js';
import { SessionsService } from './sessions.service.js';
import { toolServicesProvider } from './tool-services.js';
import { ALL_TOOLS, DOMAINS, validateCatalogue } from './tools/domains.js';

@Module({
  imports: [
    AiCoreModule,
    RecordsModule,
    FoldersModule,
    ContentTypesModule,
    SavedSearchesModule,
    MyRecordsModule,
    AccessModule,
    TrashModule,
    BulkModule,
    CommentsModule,
    RelationsModule,
    DashboardModule,
    AdminModule,
    MembersModule,
  ],
  controllers: [AiController],
  providers: [
    toolServicesProvider,
    AiAuditTrail,
    AiGate,
    AiEnabledGuard,
    PrincipalRefresher,
    SessionsService,
    ChatService,
    ActionsService,
  ],
})
export class AiModule implements OnModuleInit {
  onModuleInit(): void {
    validateCatalogue(DOMAINS, ALL_TOOLS);
  }
}
