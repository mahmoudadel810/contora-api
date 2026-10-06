import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { zodPipe } from '../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import type { TenantView } from '../tenants/tenant.schema.js';
import type { UserView } from '../users/user.schema.js';
import {
  ChangePasswordSchema,
  SignInSchema,
  SignUpSchema,
  UpdateProfileSchema,
  type ChangePasswordInput,
  type SignInInput,
  type SignUpInput,
  type UpdateProfileInput,
} from './auth.dto.js';
import { AuthService, type IssuedSession, type SessionView } from './auth.service.js';
import { CurrentUser, type Principal } from './principal.js';
import { Public } from './public.decorator.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './session-cookie.js';
import { UserThrottlerGuard } from './user-throttler.guard.js';
import { userAgentOf } from './user-agent.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('sign-up')
  async signUp(
    @Body(zodPipe(SignUpSchema)) body: SignUpInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    return this.respond(await this.auth.signUp(body, userAgentOf(request)), response);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('sign-in')
  @HttpCode(200)
  async signIn(
    @Body(zodPipe(SignInSchema)) body: SignInInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    return this.respond(await this.auth.signIn(body, userAgentOf(request)), response);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    try {
      return this.respond(
        await this.auth.refresh(readRefreshCookie(request), userAgentOf(request)),
        response,
      );
    } catch (error) {
      clearRefreshCookie(response, this.config);
      throw error;
    }
  }

  @Public()
  @Post('sign-out')
  @HttpCode(204)
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.signOut(readRefreshCookie(request));
    clearRefreshCookie(response, this.config);
  }

  @Get('me')
  me(@CurrentUser() principal: Principal): Promise<{ user: UserView; tenant: TenantView }> {
    return this.auth.me(principal);
  }

  @Patch('me')
  updateProfile(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(UpdateProfileSchema)) body: UpdateProfileInput,
  ): Promise<UserView> {
    return this.auth.updateProfile(principal, body.displayName);
  }

  @UseGuards(ThrottlerGuard, UserThrottlerGuard)
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(ChangePasswordSchema)) body: ChangePasswordInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    return this.respond(
      await this.auth.changePassword(principal, body, userAgentOf(request)),
      response,
    );
  }

  private respond(session: IssuedSession, response: Response): SessionView {
    setRefreshCookie(response, session.refresh, this.config);
    return session.view;
  }
}
