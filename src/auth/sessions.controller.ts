import { Controller, Delete, Get, HttpCode, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { zodPipe } from '../common/zod.pipe.js';
import { CurrentUser, type Principal } from './principal.js';
import { readRefreshCookie } from './session-cookie.js';
import { SessionsService, type SessionList } from './sessions.service.js';

const SessionIdSchema = z.uuid('A session id is a UUID');

@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('auth/sessions')
  listOwn(@CurrentUser() principal: Principal, @Req() request: Request): Promise<SessionList> {
    return this.sessions.listOwn(principal, readRefreshCookie(request));
  }

  @Delete('auth/sessions/:sid')
  @HttpCode(204)
  revokeOwn(
    @CurrentUser() principal: Principal,
    @Param('sid', zodPipe(SessionIdSchema)) sessionId: string,
    @Req() request: Request,
  ): Promise<void> {
    return this.sessions.revokeOwn(principal, sessionId, readRefreshCookie(request));
  }

  @Delete('auth/sessions')
  revokeOthers(
    @CurrentUser() principal: Principal,
    @Req() request: Request,
  ): Promise<{ revoked: number }> {
    return this.sessions.revokeOthers(principal, readRefreshCookie(request));
  }

  @Get('members/:id/sessions')
  listFor(@CurrentUser() principal: Principal, @Param('id') userId: string): Promise<SessionList> {
    return this.sessions.listFor(principal, userId);
  }

  @Delete('members/:id/sessions/:sid')
  @HttpCode(204)
  revokeFor(
    @CurrentUser() principal: Principal,
    @Param('id') userId: string,
    @Param('sid', zodPipe(SessionIdSchema)) sessionId: string,
  ): Promise<void> {
    return this.sessions.revokeFor(principal, userId, sessionId);
  }

  @Delete('members/:id/sessions')
  revokeAllFor(
    @CurrentUser() principal: Principal,
    @Param('id') userId: string,
  ): Promise<{ revoked: number }> {
    return this.sessions.revokeAllFor(principal, userId);
  }
}
