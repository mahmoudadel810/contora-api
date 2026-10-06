import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { activityScope } from '../authorization/policy.js';
import type { Page } from '../common/pagination.js';
import { zodPipe } from '../common/zod.pipe.js';
import {
  ActivityReportQuerySchema,
  ActivityReportService,
  type ActivityReport,
  type ActivityReportQuery,
} from './activity-report.service.js';
import { AUDIT_ACTIONS, type AuditAction } from './audit-action.js';
import {
  AuditListQuerySchema,
  AuditService,
  type AuditEntryView,
  type AuditListQuery,
} from './audit.service.js';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly reports: ActivityReportService,
  ) {}

  @Get()
  async list(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(AuditListQuerySchema)) query: AuditListQuery,
  ): Promise<Page<AuditEntryView> & { scope: 'tenant' | 'own' }> {
    await this.policy.authorize(principal, 'audit.read');
    const page = await this.audit.list(principal, query);
    return { ...page, scope: activityScope(principal) };
  }

  @Get('report')
  report(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(ActivityReportQuerySchema)) query: ActivityReportQuery,
  ): Promise<ActivityReport> {
    return this.reports.report(principal, query);
  }

  @Get('actions')
  async actions(@CurrentUser() principal: Principal): Promise<readonly AuditAction[]> {
    await this.policy.authorize(principal, 'audit.read');
    return AUDIT_ACTIONS;
  }
}
