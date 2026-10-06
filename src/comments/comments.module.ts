import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RecordsModule } from '../records/records.module.js';
import { RecordComment, RecordCommentSchema } from './comment.schema.js';
import { CommentsController } from './comments.controller.js';
import { CommentsService } from './comments.service.js';
import { MentionsController } from './mentions.controller.js';

@Module({
  imports: [
    AccessModule,
    MongooseModule.forFeature([{ name: RecordComment.name, schema: RecordCommentSchema }]),
    NotificationsModule,
    RecordsModule,
  ],
  controllers: [CommentsController, MentionsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
