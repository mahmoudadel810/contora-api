import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { zodPipe } from '../common/zod.pipe.js';
import { NotificationListQuerySchema, type NotificationListQuery } from './notifications.dto.js';
import { NotificationsService, type NotificationList } from './notifications.service.js';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(NotificationListQuerySchema)) query: NotificationListQuery,
  ): Promise<NotificationList> {
    return this.notifications.list(principal, query.unread);
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() principal: Principal): Promise<{ unread: number }> {
    return { unread: await this.notifications.unreadCount(principal) };
  }

  @Post('read-all')
  @HttpCode(204)
  readAll(@CurrentUser() principal: Principal): Promise<void> {
    return this.notifications.markAllRead(principal);
  }

  @Post(':id/read')
  @HttpCode(204)
  read(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.notifications.markRead(principal, id);
  }
}
