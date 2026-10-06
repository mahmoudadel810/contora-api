import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DisplayNameSchema, EmailSchema, PasswordSchema } from '../auth/auth.dto.js';
import type { SessionView } from '../auth/auth.service.js';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { Public } from '../auth/public.decorator.js';
import { setRefreshCookie } from '../auth/session-cookie.js';
import { userAgentOf } from '../auth/user-agent.js';
import { zodPipe } from '../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { ROLES } from '../users/role.js';
import type { UserView } from '../users/user.schema.js';
import type { InvitationView } from './invitation.schema.js';
import { InvitationsService, type InvitationPreview } from './invitations.service.js';
import { MembersService } from './members.service.js';

const ChangeRoleSchema = z.object({ role: z.enum(ROLES) }).strict();
const CreateInvitationSchema = z.object({ email: EmailSchema, role: z.enum(ROLES) }).strict();
const TokenSchema = z.string().min(20).max(200);
const PreviewQuerySchema = z.object({ token: TokenSchema });
const AcceptSchema = z
  .object({ token: TokenSchema, displayName: DisplayNameSchema, password: PasswordSchema })
  .strict();

@Controller()
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('members')
  list(@CurrentUser() principal: Principal): Promise<UserView[]> {
    return this.members.list(principal);
  }

  @Patch('members/:id')
  changeRole(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(ChangeRoleSchema)) body: z.infer<typeof ChangeRoleSchema>,
  ): Promise<UserView> {
    return this.members.changeRole(principal, id, body.role);
  }

  @Post('members/:id/suspend')
  @HttpCode(200)
  suspend(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<UserView> {
    return this.members.suspend(principal, id);
  }

  @Post('members/:id/reactivate')
  @HttpCode(200)
  reactivate(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<UserView> {
    return this.members.reactivate(principal, id);
  }

  @Delete('members/:id')
  @HttpCode(204)
  remove(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.members.remove(principal, id);
  }

  @UseGuards(ThrottlerGuard)
  @Post('invitations')
  invite(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(CreateInvitationSchema)) body: z.infer<typeof CreateInvitationSchema>,
  ): Promise<InvitationView> {
    return this.invitations.create(principal, body.email, body.role);
  }

  @Get('invitations')
  invitationsList(@CurrentUser() principal: Principal): Promise<InvitationView[]> {
    return this.invitations.list(principal);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Get('invitations/preview')
  preview(
    @Query(zodPipe(PreviewQuerySchema)) query: z.infer<typeof PreviewQuerySchema>,
  ): Promise<InvitationPreview> {
    return this.invitations.preview(query.token);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('invitations/accept')
  async accept(
    @Body(zodPipe(AcceptSchema)) body: z.infer<typeof AcceptSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    const session = await this.invitations.accept(
      body.token,
      body.displayName,
      body.password,
      userAgentOf(request),
    );
    setRefreshCookie(response, session.refresh, this.config);
    return session.view;
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  revoke(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.invitations.revoke(principal, id);
  }
}
