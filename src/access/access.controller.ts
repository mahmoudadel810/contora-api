import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { zodPipe } from '../common/zod.pipe.js';
import type {
  GrantView,
  MyAccessView,
  PutGrantResult,
  RevokeGrantResult,
  TargetGrantsView,
} from './access-grant.schema.js';
import {
  GrantListQuerySchema,
  PutGrantSchema,
  type GrantListQuery,
  type PutGrantInput,
} from './access.dto.js';
import { AccessService } from './access.service.js';

@Controller('access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('grants')
  list(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(GrantListQuerySchema)) query: GrantListQuery,
  ): Promise<TargetGrantsView | GrantView[]> {
    if (query.userId !== undefined) return this.access.listForUser(principal, query.userId);
    return this.access.listForTarget(
      principal,
      query.targetType as NonNullable<GrantListQuery['targetType']>,
      query.targetId as string,
    );
  }

  @Put('grants')
  put(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(PutGrantSchema)) body: PutGrantInput,
  ): Promise<PutGrantResult> {
    return this.access.put(principal, body);
  }

  @Delete('grants/:id')
  revoke(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<RevokeGrantResult> {
    return this.access.revoke(principal, id);
  }
}

@Controller()
export class MyAccessController {
  constructor(private readonly access: AccessService) {}

  @Get('me/access')
  mine(@CurrentUser() principal: Principal): Promise<MyAccessView> {
    return this.access.myAccess(principal);
  }
}
