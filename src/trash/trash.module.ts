import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { AiExtractionDataModule } from '../ai-extraction/ai-extraction-data.module.js';
import { CommentsModule } from '../comments/comments.module.js';
import { FoldersModule } from '../folders/folders.module.js';
import { MyRecordsModule } from '../my-records/my-records.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RecordsModule } from '../records/records.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { SharesModule } from '../shares/shares.module.js';
import { TrashController } from './trash.controller.js';
import { TrashService } from './trash.service.js';

@Module({
  imports: [
    AccessModule,
    RecordsModule,
    FoldersModule,
    CommentsModule,
    MyRecordsModule,
    NotificationsModule,
    RelationsModule,
    SharesModule,
    AiExtractionDataModule,
  ],
  controllers: [TrashController],
  providers: [TrashService],
  exports: [TrashService],
})
export class TrashModule {}
