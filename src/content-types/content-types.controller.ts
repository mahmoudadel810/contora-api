import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { zodPipe } from '../common/zod.pipe.js';
import type { ContentTypeView } from './content-type.schema.js';
import {
  ContentTypeBodySchema,
  ContentTypeListQuerySchema,
  type ContentTypeBody,
  type ContentTypeListQuery,
} from './content-types.dto.js';
import { ContentTypesService } from './content-types.service.js';

@Controller('content-types')
export class ContentTypesController {
  constructor(private readonly contentTypes: ContentTypesService) {}

  @Get()
  list(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(ContentTypeListQuerySchema)) query: ContentTypeListQuery,
  ): Promise<ContentTypeView[]> {
    return this.contentTypes.list(principal, query);
  }

  @Get(':id')
  get(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<ContentTypeView> {
    return this.contentTypes.get(principal, id);
  }

  @Post()
  create(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(ContentTypeBodySchema)) body: ContentTypeBody,
  ): Promise<ContentTypeView> {
    return this.contentTypes.create(principal, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(ContentTypeBodySchema)) body: ContentTypeBody,
  ): Promise<ContentTypeView> {
    return this.contentTypes.update(principal, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<ContentTypeView> {
    return this.contentTypes.setArchived(principal, id, true);
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  unarchive(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
  ): Promise<ContentTypeView> {
    return this.contentTypes.setArchived(principal, id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.contentTypes.delete(principal, id);
  }
}
