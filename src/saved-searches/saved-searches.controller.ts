import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { zodPipe } from '../common/zod.pipe.js';
import type { SavedSearchView } from './saved-search.schema.js';
import { CreateSavedSearchSchema, type CreateSavedSearchInput } from './saved-searches.dto.js';
import { SavedSearchesService } from './saved-searches.service.js';

@Controller('saved-searches')
export class SavedSearchesController {
  constructor(private readonly searches: SavedSearchesService) {}

  @Get()
  list(@CurrentUser() principal: Principal): Promise<SavedSearchView[]> {
    return this.searches.list(principal);
  }

  @Post()
  create(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(CreateSavedSearchSchema)) body: CreateSavedSearchInput,
  ): Promise<SavedSearchView> {
    return this.searches.create(principal, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.searches.remove(principal, id);
  }
}
