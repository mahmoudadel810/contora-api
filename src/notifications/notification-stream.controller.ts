import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser, type Principal, type RequestWithPrincipal } from '../auth/principal.js';
import { UserThrottlerGuard } from '../auth/user-throttler.guard.js';
import { APP_CONFIG, durationToSeconds, type AppConfig } from '../config/env.js';
import { NotificationHub, sseFrame } from './notification-hub.js';
import { NotificationsService } from './notifications.service.js';

export const PING_INTERVAL_MS = 25_000;
export const MAX_BUFFERED_BYTES = 1_048_576;
const MAX_TIMER_MS = 2 ** 31 - 1;

@Controller('notifications')
export class NotificationStreamController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly hub: NotificationHub,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @UseGuards(UserThrottlerGuard)
  @Throttle({ auth: { limit: 30, ttl: 60_000 } })
  @Get('stream')
  async stream(
    @CurrentUser() principal: Principal,
    @Req() request: RequestWithPrincipal,
    @Res() response: Response,
  ): Promise<void> {
    let gone = false;
    const onEarlyClose = (): void => {
      gone = true;
    };
    response.once('close', onEarlyClose);
    const unread = await this.notifications.unreadCount(principal);
    response.off('close', onEarlyClose);
    if (gone || response.destroyed) return;

    const expiresAt =
      request.accessTokenExpiresAt ??
      Date.now() + durationToSeconds(this.config.JWT_EXPIRES_IN) * 1000;

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    let open = true;
    let ping: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    const sink = {
      write: (chunk: string): void => {
        if (!open) return;
        if (response.writableLength > MAX_BUFFERED_BYTES) {
          close();
          return;
        }
        response.write(chunk);
      },
      end: (): void => close(),
    };
    const detach = this.hub.attach(principal.tenantId, principal.userId, sink);
    function close(): void {
      if (!open) return;
      open = false;
      clearInterval(ping);
      clearTimeout(expiry);
      detach();
      response.end();
    }
    ping = setInterval(() => sink.write(': ping\n\n'), PING_INTERVAL_MS);
    expiry = setTimeout(close, Math.min(MAX_TIMER_MS, Math.max(0, expiresAt - Date.now())));
    response.on('close', close);
    sink.write(sseFrame('ready', { unread }));
  }
}
