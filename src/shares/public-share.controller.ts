import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { zodPipe } from '../common/zod.pipe.js';
import { stream } from '../records/file-response.js';
import { ShareAccessService, type ShareRequest } from './share-access.service.js';
import type { ResolvedShare, UnlockedShare } from './share-link.schema.js';
import {
  ContentQuerySchema,
  NoQuerySchema,
  UnlockSchema,
  type ContentQuery,
  type UnlockInput,
} from './share-links.dto.js';

export const SHARE_TOKEN_HEADER = 'x-share-token';
export const SHARE_ACCESS_HEADER = 'x-share-access';

@Injectable()
export class PublicShareHeadersGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return true;
  }
}

function shareRequestOf(request: Request): ShareRequest {
  return {
    token: request.headers[SHARE_TOKEN_HEADER],
    access: request.headers[SHARE_ACCESS_HEADER],
    userAgent: request.headers['user-agent'],
  };
}

@Public()
@UseGuards(PublicShareHeadersGuard)
@Controller('public/share-link')
export class PublicShareController {
  constructor(private readonly shares: ShareAccessService) {}

  @UseGuards(ThrottlerGuard)
  @Get()
  resolve(
    @Req() request: Request,
    @Query(zodPipe(NoQuerySchema)) _query: object,
  ): Promise<ResolvedShare> {
    return this.shares.resolve(shareRequestOf(request));
  }

  @UseGuards(ThrottlerGuard)
  @Post('unlock')
  @HttpCode(200)
  unlock(
    @Req() request: Request,
    @Body(zodPipe(UnlockSchema)) body: UnlockInput,
    @Query(zodPipe(NoQuerySchema)) _query: object,
  ): Promise<UnlockedShare> {
    return this.shares.unlock(shareRequestOf(request), body.password);
  }

  @UseGuards(ThrottlerGuard)
  @Get('content')
  async content(
    @Req() request: Request,
    @Query(zodPipe(ContentQuerySchema)) query: ContentQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const opened = await this.shares.content(shareRequestOf(request), query.disposition);
    return stream(opened, response, query.disposition);
  }
}
