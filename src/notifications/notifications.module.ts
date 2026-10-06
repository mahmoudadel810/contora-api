import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MyRecordsModule } from '../my-records/my-records.module.js';
import { Notification, NotificationSchema } from './notification.schema.js';
import { NotificationHub } from './notification-hub.js';
import { NotificationStreamController } from './notification-stream.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [
    AccessModule,
    MongooseModule.forFeature([{ name: Notification.name, schema: NotificationSchema }]),
    MyRecordsModule,
  ],
  controllers: [NotificationsController, NotificationStreamController],
  providers: [NotificationsService, NotificationHub],
  exports: [NotificationsService, NotificationHub],
})
export class NotificationsModule {}
