import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { zodPipe } from '../common/zod.pipe.js';
import type { RelationList, RelationView } from './relation.schema.js';
import { AddRelationSchema, type AddRelationInput } from './relations.dto.js';
import { RelationsService } from './relations.service.js';

@Controller('records/:id/relations')
export class RelationsController {
  constructor(private readonly relations: RelationsService) {}

  @Get()
  list(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<RelationList> {
    return this.relations.list(principal, id);
  }

  @Post()
  add(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(AddRelationSchema)) body: AddRelationInput,
  ): Promise<RelationView> {
    return this.relations.add(principal, id, body);
  }

  @Delete(':relationId')
  @HttpCode(204)
  remove(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Param('relationId') relationId: string,
  ): Promise<void> {
    return this.relations.remove(principal, id, relationId);
  }
}
