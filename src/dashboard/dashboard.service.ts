import { Injectable } from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import type { AuditAction } from '../audit/audit-action.js';
import { AuditService, type AuditEntryView } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { activityScope } from '../authorization/policy.js';
import { ContentTypesRepository } from '../content-types/content-types.repository.js';
import { toObjectId } from '../database/object-id.js';
import { FoldersRepository } from '../folders/folders.repository.js';
import type { RecordView } from '../records/record.view.js';
import { RecordsRepository, VersionsRepository } from '../records/records.repository.js';
import { RecordsService } from '../records/records.service.js';
import { BlobsService } from '../storage/blobs.service.js';
import { UsersRepository } from '../users/users.repository.js';

export interface DashboardView {
  counts: {
    records: number;
    folders: number;
    contentTypes: number;
    versions: number | null;
    members: number | null;
    trashed: number | null;
  };
  storage: { storedBytes: number; storedFiles: number; versionBytes: number } | null;
  myCheckouts: RecordView[];
  recentRecords: RecordView[];
  recentActivity: AuditEntryView[];
  activityScope: 'tenant' | 'own';
}

const RECENT = 8;
const RECENT_ACTIVITY = 10;
const HIDDEN_FROM_ACTIVITY: readonly AuditAction[] = ['SIGN_IN', 'SIGN_OUT'];

@Injectable()
export class DashboardService {
  constructor(
    private readonly records: RecordsRepository,
    private readonly versions: VersionsRepository,
    private readonly recordsService: RecordsService,
    private readonly folders: FoldersRepository,
    private readonly contentTypes: ContentTypesRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly blobs: BlobsService,
    private readonly access: AccessService,
  ) {}

  async summary(principal: Principal): Promise<DashboardView> {
    await this.policy.authorize(principal, 'records.read');
    const tenantId = principal.tenantId;
    const scope = await this.access.scopeFor(principal);
    const tenantWide = scope.unrestricted;
    const visible = scope.recordFilter('view');
    const [records, folders, contentTypes, tenantFigures, mine, recent, activity] =
      await Promise.all([
        this.records.count(tenantId, { $and: [visible, { deletedAt: null }] }),
        this.folders.count(tenantId, {
          $and: [scope.folderFilter('view'), { deletedAt: null, isRoot: false }],
        }),
        this.contentTypes.count(tenantId, { status: 'active' }),
        tenantWide ? this.tenantFigures(tenantId) : Promise.resolve(null),
        this.records.find(
          tenantId,
          { $and: [visible, { deletedAt: null, checkedOutBy: toObjectId(principal.userId) }] },
          { sort: { checkedOutAt: -1 }, limit: 50 },
        ),
        this.records.find(
          tenantId,
          { $and: [visible, { deletedAt: null }] },
          { sort: { updatedAt: -1 }, limit: RECENT },
        ),
        this.audit.latest(
          principal,
          { excludeActions: HIDDEN_FROM_ACTIVITY, limit: RECENT_ACTIVITY },
          await this.access.feedAccess(principal),
        ),
      ]);
    const [myCheckouts, recentRecords] = await Promise.all([
      this.recordsService.withNames(tenantId, mine, scope),
      this.recordsService.withNames(tenantId, recent, scope),
    ]);
    return {
      counts: {
        records,
        folders,
        contentTypes,
        versions: tenantFigures?.versions ?? null,
        members: tenantFigures?.members ?? null,
        trashed: tenantFigures?.trashed ?? null,
      },
      storage: tenantFigures?.storage ?? null,
      myCheckouts,
      recentRecords,
      recentActivity: activity,
      activityScope: activityScope(principal),
    };
  }

  private async tenantFigures(tenantId: string) {
    const [versions, members, trashed, stored, versionBytes] = await Promise.all([
      this.versions.count(tenantId, {}),
      this.users.count(tenantId, { status: 'active' }),
      this.records.count(tenantId, { deletedAt: { $ne: null } }),
      this.blobs.usage(tenantId),
      this.versions.aggregateSum(tenantId, 'file.size'),
    ]);
    return {
      versions,
      members,
      trashed,
      storage: { storedBytes: stored.bytes, storedFiles: stored.files, versionBytes },
    };
  }
}
