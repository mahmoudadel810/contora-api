import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { UserThrottlerGuard } from '../auth/user-throttler.guard.js';
import type { Page } from '../common/pagination.js';
import { zodPipe } from '../common/zod.pipe.js';
import type {
  AdminShareLinkView,
  CreatedShareLinkView,
  ShareLinkView,
} from './share-link.schema.js';
import {
  CreateShareLinkSchema,
  ListShareLinksQuerySchema,
  RecordShareLinksQuerySchema,
  type CreateShareLinkInput,
  type ListShareLinksQuery,
  type RecordShareLinksQuery,
} from './share-links.dto.js';
import { ShareLinksService } from './share-links.service.js';

@Controller()
export class ShareLinksController {
  constructor(private readonly shareLinks: ShareLinksService) {}

  @UseGuards(ThrottlerGuard, UserThrottlerGuard)
  @Post('records/:id/share-links')
  create(
    @CurrentUser() principal: Principal,
    @Param('id') recordId: string,
    @Body(zodPipe(CreateShareLinkSchema)) body: CreateShareLinkInput,
  ): Promise<CreatedShareLinkView> {
    return this.shareLinks.create(principal, recordId, body);
  }

  @Get('records/:id/share-links')
  listForRecord(
    @CurrentUser() principal: Principal,
    @Param('id') recordId: string,
    @Query(zodPipe(RecordShareLinksQuerySchema)) query: RecordShareLinksQuery,
  ): Promise<Page<ShareLinkView>> {
    return this.shareLinks.listForRecord(principal, recordId, query);
  }

  @Get('share-links')
  listForTenant(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(ListShareLinksQuerySchema)) query: ListShareLinksQuery,
  ): Promise<Page<AdminShareLinkView>> {
    return this.shareLinks.listForTenant(principal, query);
  }

  @Delete('share-links/:id')
  @HttpCode(204)
  revoke(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.shareLinks.revoke(principal, id);
  }
}
