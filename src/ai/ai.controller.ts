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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser, type Principal } from '../auth/principal.js';
import type { Page } from '../common/pagination.js';
import { parseWith, zodPipe } from '../common/zod.pipe.js';
import { discardTemp, ingestible } from '../records/uploads.js';
import type { ActionView } from './actions/action-view.js';
import { ActionsService } from './actions/actions.service.js';
import { AiEnabledGuard } from './ai-enabled.guard.js';
import { AiProvider } from './ai-provider.js';
import { AI_SETTINGS, type AiSettings } from './ai-settings.js';
import {
  ChatBodySchema,
  ConfirmBodySchema,
  RenameSessionSchema,
  SessionsQuerySchema,
  type ChatBody,
  type RenameSessionInput,
  type SessionsQuery,
} from './ai.dto.js';
import { ChatService } from './chat.service.js';
import { NDJSON_HEADERS, responseSink } from './frames.js';
import { SessionsService, type SessionDetailView, type SessionView } from './sessions.service.js';
import { domainsFor } from './tools/domains.js';

export interface AiStatusView {
  enabled: boolean;
  reason: null | 'NOT_CONFIGURED';
  model: string | null;
  maxMessageChars: number;
  actionTimeoutMs: number;
  domains: string[];
}

@Controller('ai')
export class AiController {
  constructor(
    private readonly provider: AiProvider,
    private readonly chats: ChatService,
    private readonly sessions: SessionsService,
    private readonly actions: ActionsService,
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
  ) {}

  @Get('status')
  status(@CurrentUser() principal: Principal): AiStatusView {
    const status = this.provider.status();
    return {
      ...status,
      maxMessageChars: this.settings.limits.maxInputChars,
      actionTimeoutMs: this.settings.limits.requestTimeoutMs,
      domains: status.enabled ? domainsFor(principal).map((domain) => domain.name) : [],
    };
  }

  @Post('chat')
  @HttpCode(200)
  @UseGuards(AiEnabledGuard)
  async chat(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(ChatBodySchema)) body: ChatBody,
    @Res() res: Response,
  ): Promise<void> {
    const authenticatedAt = new Date();
    const turn = await this.chats.begin(principal, body, authenticatedAt);
    res.status(200);
    for (const [name, value] of Object.entries(NDJSON_HEADERS)) res.setHeader(name, value);
    res.flushHeaders();
    const client = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) client.abort();
    });
    if (res.destroyed) client.abort();
    await turn.run(responseSink(res), client.signal);
  }

  @Get('sessions')
  list(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(SessionsQuerySchema)) query: SessionsQuery,
  ): Promise<Page<SessionView>> {
    return this.sessions.list(principal, query);
  }

  @Get('sessions/:id')
  get(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<SessionDetailView> {
    return this.sessions.get(principal, id);
  }

  @Patch('sessions/:id')
  rename(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(RenameSessionSchema)) body: RenameSessionInput,
  ): Promise<SessionView> {
    return this.sessions.rename(principal, id, body);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  remove(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.sessions.remove(principal, id);
  }

  @Post('actions/:id/confirm')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  async confirm(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<{ action: ActionView }> {
    try {
      const input = parseWith(ConfirmBodySchema, body ?? {});
      return await this.actions.confirm(principal, id, {
        acknowledgeDestructive: input.acknowledgeDestructive,
        file: ingestible(file),
      });
    } finally {
      await discardTemp(file);
    }
  }

  @Post('actions/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ action: ActionView }> {
    return this.actions.cancel(principal, id);
  }
}
