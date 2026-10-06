import type { Provider } from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import { AdminService } from '../admin/admin.service.js';
import { ActivityReportService } from '../audit/activity-report.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../authorization/policy.service.js';
import { BulkService } from '../bulk/bulk.service.js';
import { CommentsService } from '../comments/comments.service.js';
import { ContentTypesService } from '../content-types/content-types.service.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { FoldersService } from '../folders/folders.service.js';
import { MembersService } from '../members/members.service.js';
import { MyRecordsService } from '../my-records/my-records.service.js';
import { RecordsService } from '../records/records.service.js';
import { RelationsService } from '../relations/relations.service.js';
import { SavedSearchesService } from '../saved-searches/saved-searches.service.js';
import { TrashService } from '../trash/trash.service.js';
import type { ToolServices } from './tools/tool.js';

export const TOOL_SERVICES = 'AI_TOOL_SERVICES';

const SERVICES = [
  RecordsService,
  FoldersService,
  ContentTypesService,
  SavedSearchesService,
  MyRecordsService,
  AccessService,
  TrashService,
  BulkService,
  CommentsService,
  RelationsService,
  DashboardService,
  AdminService,
  AuditService,
  ActivityReportService,
  MembersService,
  PolicyService,
] as const;

export const toolServicesProvider: Provider = {
  provide: TOOL_SERVICES,
  inject: [...SERVICES],
  useFactory: (
    records: RecordsService,
    folders: FoldersService,
    contentTypes: ContentTypesService,
    savedSearches: SavedSearchesService,
    myRecords: MyRecordsService,
    access: AccessService,
    trash: TrashService,
    bulk: BulkService,
    comments: CommentsService,
    relations: RelationsService,
    dashboard: DashboardService,
    admin: AdminService,
    audit: AuditService,
    activityReport: ActivityReportService,
    members: MembersService,
    policy: PolicyService,
  ): ToolServices => ({
    records,
    folders,
    contentTypes,
    savedSearches,
    myRecords,
    access,
    trash,
    bulk,
    comments,
    relations,
    dashboard,
    admin,
    audit,
    activityReport,
    members,
    policy,
  }),
};
