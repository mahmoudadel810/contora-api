import { Injectable } from '@nestjs/common';
import { SECURITY_ACTIONS } from '../audit/audit-action.js';
import { AuditService, type AuditEntryView } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { ContentTypesRepository } from '../content-types/content-types.repository.js';
import { FoldersRepository } from '../folders/folders.repository.js';
import { InvitationsRepository } from '../members/invitations.repository.js';
import { RecordsRepository } from '../records/records.repository.js';
import { BlobsService } from '../storage/blobs.service.js';
import { UsersRepository } from '../users/users.repository.js';

export interface AdminOverview {
  generatedAt: string;
  members: { active: number; suspended: number; removed: number; activeAdmins: number };
  invitations: { pending: number };
  records: { live: number; trashed: number; createdLast7Days: number; createdLast30Days: number };
  folders: { live: number; trashed: number };
  contentTypes: { active: number; archived: number };
  storage: { bytes: number; files: number };
  security: {
    last7Days: { signInFailed: number; accessDenied: number; tokenReuse: number };
    recent: AuditEntryView[];
  };
}

const DAY_MS = 86_400_000;
const RECENT_SECURITY = 10;

@Injectable()
export class AdminService {
  constructor(
    private readonly policy: PolicyService,
    private readonly users: UsersRepository,
    private readonly invitations: InvitationsRepository,
    private readonly records: RecordsRepository,
    private readonly folders: FoldersRepository,
    private readonly contentTypes: ContentTypesRepository,
    private readonly blobs: BlobsService,
    private readonly audit: AuditService,
  ) {}

  async overview(principal: Principal): Promise<AdminOverview> {
    await this.policy.authorize(principal, 'admin.overview', { type: 'admin', label: 'overview' });
    const tenantId = principal.tenantId;
    const now = new Date();
    const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const [
      active,
      suspended,
      removed,
      activeAdmins,
      pending,
      liveRecords,
      trashedRecords,
      created7,
      created30,
      liveFolders,
      trashedFolders,
      activeTypes,
      archivedTypes,
      storage,
      signInFailed,
      accessDenied,
      tokenReuse,
      recent,
    ] = await Promise.all([
      this.users.count(tenantId, { status: 'active' }),
      this.users.count(tenantId, { status: 'suspended' }),
      this.users.count(tenantId, { status: 'removed' }),
      this.users.count(tenantId, { status: 'active', role: 'admin' }),
      this.invitations.countPending(tenantId, now),
      this.records.count(tenantId, { deletedAt: null }),
      this.records.count(tenantId, { deletedAt: { $ne: null } }),
      this.audit.countSince(tenantId, 'RECORD_CREATED', since(7)),
      this.audit.countSince(tenantId, 'RECORD_CREATED', since(30)),
      this.folders.count(tenantId, { deletedAt: null, isRoot: false }),
      this.folders.count(tenantId, { deletedAt: { $ne: null } }),
      this.contentTypes.count(tenantId, { status: 'active' }),
      this.contentTypes.count(tenantId, { status: 'archived' }),
      this.blobs.usage(tenantId),
      this.audit.countSince(tenantId, 'SIGN_IN_FAILED', since(7)),
      this.audit.countSince(tenantId, 'ACCESS_DENIED', since(7)),
      this.audit.countSince(tenantId, 'TOKEN_REUSE_DETECTED', since(7)),
      this.audit.latest(principal, { actions: SECURITY_ACTIONS, limit: RECENT_SECURITY }),
    ]);
    return {
      generatedAt: now.toISOString(),
      members: { active, suspended, removed, activeAdmins },
      invitations: { pending },
      records: {
        live: liveRecords,
        trashed: trashedRecords,
        createdLast7Days: created7,
        createdLast30Days: created30,
      },
      folders: { live: liveFolders, trashed: trashedFolders },
      contentTypes: { active: activeTypes, archived: archivedTypes },
      storage,
      security: { last7Days: { signInFailed, accessDenied, tokenReuse }, recent },
    };
  }
}
