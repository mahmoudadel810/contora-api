import { Controller, Get, Param, Query } from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import { AuditService, type AuditActivityPage } from '../audit/audit.service.js';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { PageQuerySchema, type PageQuery } from '../common/pagination.js';
import { zodPipe } from '../common/zod.pipe.js';
import { RecordsService } from './records.service.js';

const ActivityQuerySchema = PageQuerySchema.strict();

@Controller('records/:id/activity')
export class RecordActivityController {
  constructor(
    private readonly records: RecordsService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async list(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Query(zodPipe(ActivityQuerySchema)) query: PageQuery,
  ): Promise<AuditActivityPage> {
    await this.policy.authorize(principal, 'records.read', { type: 'record', id });
    const record = await this.records.requireVisible(principal, id);
    return this.audit.forResource(
      principal.tenantId,
      { type: 'record', id: record.id as string },
      query,
      await this.access.feedAccess(principal),
    );
  }
}
