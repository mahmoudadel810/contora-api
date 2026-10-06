import { Module } from '@nestjs/common';
import { AccessModule } from './access/access.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AiModule } from './ai/ai.module.js';
import { AiExtractionModule } from './ai-extraction/ai-extraction.module.js';
import { ApiReferenceModule } from './api-reference/api-reference.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { BulkModule } from './bulk/bulk.module.js';
import { CommentsModule } from './comments/comments.module.js';
import { ConfigModule } from './config/config.module.js';
import { ContentTypesModule } from './content-types/content-types.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { DatabaseModule } from './database/database.module.js';
import { FoldersModule } from './folders/folders.module.js';
import { EventsModule } from './events/domain-events.js';
import { HealthModule } from './health/health.module.js';
import { MyRecordsModule } from './my-records/my-records.module.js';
import { MembersModule } from './members/members.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RecordsModule } from './records/records.module.js';
import { RelationsModule } from './relations/relations.module.js';
import { SavedSearchesModule } from './saved-searches/saved-searches.module.js';
import { SharesModule } from './shares/shares.module.js';
import { StorageModule } from './storage/storage.module.js';
import { TrashModule } from './trash/trash.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    EventsModule,
    AuditModule,
    AuthorizationModule,
    UsersModule,
    AuthModule,
    StorageModule,
    HealthModule,
    ContentTypesModule,
    FoldersModule,
    RecordsModule,
    AccessModule,
    TrashModule,
    MembersModule,
    DashboardModule,
    CommentsModule,
    RelationsModule,
    BulkModule,
    MyRecordsModule,
    SavedSearchesModule,
    NotificationsModule,
    SharesModule,
    AdminModule,
    ApiReferenceModule,
    AiModule,
    AiExtractionModule,
  ],
})
export class AppModule {}
