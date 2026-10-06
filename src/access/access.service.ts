import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { HydratedDocument, QueryFilter, Types } from 'mongoose';
import type { FeedAccessResolver } from '../audit/audit-view-redaction.js';
import { AuditService, type AuditResource } from '../audit/audit.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { isDuplicateKey } from '../common/duplicate-key.js';
import { AppError, errors } from '../common/errors.js';
import { idOf, isObjectId, toObjectId } from '../database/object-id.js';
import type { Folder, FolderDocument } from '../folders/folder.schema.js';
import type { RecordDocument, RecordEntity } from '../records/record.schema.js';
import type { UserDocument } from '../users/user.schema.js';
import { UsersRepository } from '../users/users.repository.js';
import {
  AccessScope,
  atLeast,
  maxLevel,
  type AccessLevel,
  type GrantTargetType,
  type IdLike,
  type ScopeGrant,
} from './access-scope.js';
import {
  type AccessGrant,
  type AccessGrantDocument,
  type GrantView,
  type InheritedGrantView,
  type MyAccessView,
  type PutGrantResult,
  type RevokeGrantResult,
  type TargetGrantsView,
} from './access-grant.schema.js';
import {
  AccessFoldersReader,
  AccessGrantsRepository,
  AccessRecordsReader,
  type FolderPath,
} from './access-grants.repository.js';
import type { PutGrantInput } from './access.dto.js';

export const MAX_GRANTS_PER_USER = 500;

const PUT_ATTEMPTS = 3;

const HELD_CHECKOUTS_SCANNED = 500;

export interface ScopeOptions {
  fresh?: boolean;
}

export interface RequireOptions {
  trashed?: boolean;
  what?: string;
}

export interface RequireFolderOptions extends RequireOptions {
  itself?: boolean;
}

type Doc<T> = HydratedDocument<T>;

interface LiveTarget {
  name: string;
  above: Types.ObjectId[];
}

function grantKey(input: Pick<PutGrantInput, 'userId' | 'targetType' | 'targetId'>) {
  return {
    userId: toObjectId(input.userId),
    targetType: input.targetType,
    targetId: toObjectId(input.targetId),
  };
}

function grantLimit() {
  return errors.conflict(
    'GRANT_LIMIT',
    `A user can hold at most ${MAX_GRANTS_PER_USER} grants; grant a folder above instead`,
  );
}

@Injectable()
export class AccessService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Access');
  private readonly scopes = new WeakMap<Principal, Promise<AccessScope>>();

  constructor(
    private readonly grants: AccessGrantsRepository,
    private readonly folders: AccessFoldersReader,
    private readonly records: AccessRecordsReader,
    private readonly users: UsersRepository,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  scopeFor(principal: Principal, options: ScopeOptions = {}): Promise<AccessScope> {
    if (principal.role === 'admin') return Promise.resolve(AccessScope.unrestricted());
    const cached = this.scopes.get(principal);
    if (cached && !options.fresh) return cached;
    const computed = this.memberScope(principal.tenantId, principal.userId);
    this.scopes.set(principal, computed);
    computed.catch(() => {
      if (this.scopes.get(principal) === computed) this.scopes.delete(principal);
    });
    return computed;
  }

  async scopeForUser(tenantId: string, userId: string): Promise<AccessScope> {
    const user = await this.users.findById(tenantId, userId);
    if (!user || user.status !== 'active') return AccessScope.none();
    if (user.role === 'admin') return AccessScope.unrestricted();
    return this.memberScope(tenantId, userId);
  }

  async requireRecord(
    principal: Principal,
    id: string,
    min: AccessLevel,
    options: RequireOptions = {},
  ): Promise<RecordDocument> {
    const scope = await this.scopeFor(principal);
    const what = options.what ?? 'Record';
    const record = await this.records.findById(principal.tenantId, id);
    if (!record || (record.deletedAt !== null) !== (options.trashed ?? false)) {
      throw errors.notFound(what);
    }
    await this.assertLevel(
      principal,
      { type: 'record', id, label: record.name },
      scope.levelOfRecord(record),
      min,
      what,
    );
    return record;
  }

  async requireFolder(
    principal: Principal,
    id: string,
    min: AccessLevel,
    options: RequireFolderOptions = {},
  ): Promise<FolderDocument> {
    const scope = await this.scopeFor(principal);
    const what = options.what ?? 'Folder';
    const folder = await this.folders.findById(principal.tenantId, id);
    if (!folder || (folder.deletedAt !== null) !== (options.trashed ?? false)) {
      throw errors.notFound(what);
    }
    const resource = { type: 'folder', id, label: folder.name };
    const visible = scope.levelOfFolder(folder);
    const level = options.itself && visible !== null ? scope.levelOfFolderItself(folder) : visible;
    if (visible !== null && level === null) await this.deny(principal, resource, min, level);
    await this.assertLevel(principal, resource, level, min, what);
    return folder;
  }

  async assertLevel(
    principal: Principal,
    resource: AuditResource,
    level: AccessLevel | null,
    min: AccessLevel,
    what = resource.type.charAt(0).toUpperCase() + resource.type.slice(1),
  ): Promise<void> {
    if (level === null) throw errors.notFound(what);
    if (!atLeast(level, min)) await this.deny(principal, resource, min, level);
  }

  async refusalFor(
    principal: Principal,
    resource: AuditResource,
    level: AccessLevel | null,
    min: AccessLevel,
  ): Promise<AppError | null> {
    try {
      await this.assertLevel(principal, resource, level, min);
      return null;
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
  }

  async visibleRecordIds(
    principal: Principal,
    ids: readonly IdLike[],
    min: AccessLevel = 'view',
  ): Promise<Set<string>> {
    const valid = [...new Set(ids.map(idString))].filter(isObjectId);
    if (valid.length === 0) return new Set();
    const scope = await this.scopeFor(principal);
    const found = await this.records.find(principal.tenantId, {
      $and: [{ _id: { $in: valid.map(toObjectId) } }, scope.recordFilter(min)],
    });
    return new Set(found.map((record) => idOf(record)));
  }

  async viewersOf(
    tenantId: string,
    recordId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    const ids = [...new Set(userIds)].filter(isObjectId);
    if (ids.length === 0 || !isObjectId(recordId)) return new Set();
    const record = await this.records.findById(tenantId, recordId);
    if (!record || record.deletedAt !== null || record.purgeToken !== null) return new Set();
    const folder = await this.folders.findById(tenantId, record.folderId.toHexString());
    const path = folder ? [...folder.ancestorIds, folder._id] : [record.folderId];
    const [users, grants] = await Promise.all([
      this.users.find(tenantId, { _id: { $in: ids.map(toObjectId) }, status: 'active' }),
      this.grants.find(tenantId, {
        userId: { $in: ids.map(toObjectId) },
        $or: [
          { targetType: 'record', targetId: record._id },
          { targetType: 'folder', targetId: { $in: path } },
        ],
      }),
    ]);
    const granted = new Set(grants.map((grant) => grant.userId.toHexString()));
    return new Set(
      users.filter((user) => user.role === 'admin' || granted.has(idOf(user))).map(idOf),
    );
  }

  async myAccess(principal: Principal): Promise<MyAccessView> {
    const scope = await this.scopeFor(principal);
    if (scope.unrestricted) return { unrestricted: true, entryPoints: [] };
    const tenantId = principal.tenantId;
    const recordGrants = await this.grants.find(tenantId, {
      userId: toObjectId(principal.userId),
      targetType: 'record',
    });
    const grantedRecords =
      recordGrants.length === 0
        ? []
        : await this.records.find(tenantId, {
            _id: { $in: recordGrants.map((grant) => grant.targetId) },
            deletedAt: null,
          });
    const points = scope.entryPoints(grantedRecords);
    const folderIds = points.filter((p) => p.type === 'folder').map((p) => toObjectId(p.id));
    const folders =
      folderIds.length === 0
        ? []
        : await this.folders.find(tenantId, { _id: { $in: folderIds }, deletedAt: null });
    const names = new Map<string, string>([
      ...folders.map((f): [string, string] => [`folder:${idOf(f)}`, f.name]),
      ...grantedRecords.map((r): [string, string] => [`record:${idOf(r)}`, r.name]),
    ]);
    const entryPoints = points.flatMap((point) => {
      const name = names.get(`${point.type}:${point.id}`);
      return name === undefined ? [] : [{ ...point, name }];
    });
    entryPoints.sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    return { unrestricted: false, entryPoints };
  }

  async feedAccess(principal: Principal): Promise<FeedAccessResolver | null> {
    const scope = await this.scopeFor(principal);
    if (scope.unrestricted) return null;
    return async ({ folderIds, recordIds }) => {
      const visible = await this.visibleRecordIds(principal, recordIds);
      return {
        hideActorEmail: true,
        hiddenFolderIds: new Set(
          folderIds.filter((id) => !isObjectId(id) || scope.levelOfFolderId(id) === null),
        ),
        hiddenRecordIds: new Set(recordIds.filter((id) => !visible.has(id))),
      };
    };
  }

  async recordScope(principal: Principal, min: AccessLevel): Promise<QueryFilter<RecordEntity>> {
    return (await this.scopeFor(principal)).recordFilter(min);
  }

  async folderFilter(principal: Principal, min: AccessLevel): Promise<QueryFilter<Folder>> {
    return (await this.scopeFor(principal)).folderFilter(min);
  }

  async listForTarget(
    principal: Principal,
    targetType: GrantTargetType,
    targetId: string,
  ): Promise<TargetGrantsView> {
    await this.policy.authorize(principal, 'access.manage', { type: targetType, id: targetId });
    const tenantId = principal.tenantId;
    const target = await this.requireLiveTarget(tenantId, targetType, targetId);
    const [direct, inherited] = await Promise.all([
      this.grants.find(tenantId, { targetType, targetId: toObjectId(targetId) }),
      target.above.length === 0
        ? Promise.resolve([])
        : this.grants.find(tenantId, { targetType: 'folder', targetId: { $in: target.above } }),
    ]);
    const views = await this.views(tenantId, [...direct, ...inherited]);
    const byUserName = (a: GrantView, b: GrantView) =>
      (a.userName ?? '').localeCompare(b.userName ?? '') || a.id.localeCompare(b.id);
    const depth = new Map(target.above.map((id, index) => [id.toHexString(), index]));
    return {
      target: { type: targetType, id: targetId, name: target.name },
      direct: views.slice(0, direct.length).sort(byUserName),
      inherited: views
        .slice(direct.length)
        .map((view): InheritedGrantView => ({
          ...view,
          from: { type: 'folder', id: view.targetId, name: view.targetName ?? '' },
        }))
        .sort(
          (a, b) => (depth.get(a.targetId) ?? 0) - (depth.get(b.targetId) ?? 0) || byUserName(a, b),
        ),
    };
  }

  async listForUser(principal: Principal, userId: string): Promise<GrantView[]> {
    await this.policy.authorize(principal, 'access.manage', { type: 'user', id: userId });
    const tenantId = principal.tenantId;
    const user = await this.users.findById(tenantId, userId);
    if (!user || user.status === 'removed') throw errors.notFound('Member');
    const grants = await this.grants.find(tenantId, { userId: user._id });
    const views = await this.views(tenantId, grants);
    return views.sort(
      (a, b) =>
        a.targetType.localeCompare(b.targetType) ||
        (a.targetName ?? '').localeCompare(b.targetName ?? '') ||
        a.id.localeCompare(b.id),
    );
  }

  async put(principal: Principal, input: PutGrantInput): Promise<PutGrantResult> {
    await this.policy.authorize(principal, 'access.manage', { type: 'user', id: input.userId });
    const tenantId = principal.tenantId;
    const grantee = await this.requireGrantee(tenantId, input.userId);
    const target = await this.requireLiveTarget(tenantId, input.targetType, input.targetId);
    const key = grantKey(input);
    for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt += 1) {
      const existing = await this.grants.findOne(tenantId, key);
      if (existing?.level === input.level) {
        const [view] = await this.views(tenantId, [existing]);
        return { ...view, created: false };
      }
      const written = existing
        ? await this.grants.updateOne(
            tenantId,
            { _id: existing._id, level: existing.level },
            { level: input.level },
          )
        : await this.createGrant(principal, input);
      if (!written) continue;
      if (!existing) await this.confirmCreated(tenantId, input, written);
      await this.audit.record(tenantId, {
        action: 'ACCESS_GRANTED',
        actor: actorOf(principal),
        resource: { type: input.targetType, id: input.targetId, label: target.name },
        context: {
          userId: input.userId,
          userEmail: grantee.email,
          level: input.level,
          previousLevel: existing?.level ?? null,
        },
      });
      const [view] = await this.views(tenantId, [written]);
      return { ...view, created: !existing };
    }
    throw errors.conflict(
      'GRANT_CHANGED_CONCURRENTLY',
      'This grant was changed meanwhile; reload and try again',
    );
  }

  async revoke(principal: Principal, grantId: string): Promise<RevokeGrantResult> {
    await this.policy.authorize(principal, 'access.manage', { type: 'grant', id: grantId });
    const tenantId = principal.tenantId;
    const grant = isObjectId(grantId)
      ? await this.grants.findOneAndDelete(tenantId, { _id: toObjectId(grantId) })
      : null;
    if (!grant) throw errors.notFound('Grant');
    const grantee = await this.users.findById(tenantId, grant.userId.toHexString());
    const heldCheckouts =
      grantee?.role === 'admin' ? [] : await this.heldAfterRevoke(tenantId, grant);
    const [view] = await this.views(tenantId, [grant]);
    await this.audit.record(tenantId, {
      action: 'ACCESS_REVOKED',
      actor: actorOf(principal),
      resource: {
        type: grant.targetType,
        id: grant.targetId.toHexString(),
        label: view.targetName ?? undefined,
      },
      context: {
        userId: grant.userId.toHexString(),
        userEmail: grantee?.email ?? null,
        level: grant.level,
        heldCheckouts: heldCheckouts.length,
      },
    });
    return { heldCheckouts };
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      for (const tenantId of await this.grants.tenantsWithGrants()) {
        await this.clearRemovedUsers(tenantId);
      }
    } catch (error) {
      this.logger.warn(
        `Could not clear the grants of removed users: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  async clearRemovedUsers(tenantId: string): Promise<number> {
    const holders = (await this.grants.distinct(tenantId, 'userId', {})) as Types.ObjectId[];
    if (holders.length === 0) return 0;
    const removed = await this.users.find(tenantId, {
      _id: { $in: holders },
      status: 'removed',
    });
    if (removed.length === 0) return 0;
    return this.grants.deleteMany(tenantId, { userId: { $in: removed.map((user) => user._id) } });
  }

  async clearForUser(
    tenantId: string,
    userId: string,
    options: { createdBefore?: Date } = {},
  ): Promise<number> {
    if (!isObjectId(userId)) return 0;
    return this.grants.deleteMany(tenantId, {
      userId: toObjectId(userId),
      ...(options.createdBefore ? { createdAt: { $lt: options.createdBefore } } : {}),
    });
  }

  async purgeForTargets(
    tenantId: string,
    targets: { folderIds?: readonly IdLike[]; recordIds?: readonly IdLike[] },
  ): Promise<number> {
    const valid = (ids: readonly IdLike[] = []) =>
      ids.map((id) => (typeof id === 'string' ? id : id.toHexString())).filter(isObjectId);
    const clauses = [
      { targetType: 'folder' as const, ids: valid(targets.folderIds).map(toObjectId) },
      { targetType: 'record' as const, ids: valid(targets.recordIds).map(toObjectId) },
    ].filter((clause) => clause.ids.length > 0);
    if (clauses.length === 0) return 0;
    return this.grants.deleteMany(tenantId, {
      $or: clauses.map((clause) => ({
        targetType: clause.targetType,
        targetId: { $in: [...clause.ids] },
      })),
    });
  }

  private async memberScope(tenantId: string, userId: string): Promise<AccessScope> {
    if (!isObjectId(userId)) return AccessScope.none();
    return this.scopeOf(tenantId, await this.grants.find(tenantId, { userId: toObjectId(userId) }));
  }

  private async scopeOf(tenantId: string, grants: readonly ScopeGrant[]): Promise<AccessScope> {
    const folderLevels = new Map<string, AccessLevel>();
    for (const grant of grants) {
      if (grant.targetType !== 'folder') continue;
      const id = idString(grant.targetId);
      folderLevels.set(id, maxLevel(folderLevels.get(id) ?? null, grant.level) as AccessLevel);
    }
    if (folderLevels.size === 0) return AccessScope.fromGrants(grants, []);
    const granted = await this.folders.paths(tenantId, {
      _id: { $in: [...folderLevels.keys()].map(toObjectId) },
    });
    const root = granted.find((folder) => folder.isRoot);
    const rootLevel = root ? (folderLevels.get(idOf(root)) ?? null) : null;
    const expand = granted.filter(
      (folder) => !folder.isRoot && !atLeast(rootLevel, folderLevels.get(idOf(folder)) ?? 'view'),
    );
    const beneath: FolderPath[] =
      expand.length === 0
        ? []
        : await this.folders.paths(tenantId, { ancestorIds: { $in: expand.map((f) => f._id) } });
    return AccessScope.fromGrants(grants, [...granted, ...beneath], root?._id ?? null);
  }

  private async deny(
    principal: Principal,
    resource: AuditResource,
    min: AccessLevel,
    level: AccessLevel | null,
  ): Promise<never> {
    await this.audit.record(principal.tenantId, {
      action: 'ACCESS_DENIED',
      actor: actorOf(principal),
      resource,
      context: {
        attemptedAction: `access.${min}`,
        attemptedAccess: min,
        level,
        role: principal.role,
      },
    });
    throw errors.forbidden();
  }

  private async requireGrantee(tenantId: string, userId: string): Promise<UserDocument> {
    const user = await this.users.findById(tenantId, userId);
    if (!user || user.status === 'removed') throw errors.notFound('Member');
    if (user.role === 'admin') {
      throw errors.conflict('GRANTEE_IS_ADMIN', 'Admins already have access to everything');
    }
    if (user.status === 'suspended') {
      throw errors.conflict('GRANTEE_SUSPENDED', 'This member is suspended; reactivate them first');
    }
    return user;
  }

  private async requireLiveTarget(
    tenantId: string,
    targetType: GrantTargetType,
    targetId: string,
  ): Promise<LiveTarget> {
    const isLive = (row: { deletedAt: Date | null; purgeToken: string | null } | null) =>
      row !== null && row.deletedAt === null && row.purgeToken === null;
    if (targetType === 'folder') {
      const folder = await this.folders.findById(tenantId, targetId);
      if (!folder || !isLive(folder)) throw errors.notFound('Folder');
      return { name: folder.name, above: [...folder.ancestorIds] };
    }
    const record = await this.records.findById(tenantId, targetId);
    if (!record || !isLive(record)) throw errors.notFound('Record');
    const folder = await this.folders.findById(tenantId, record.folderId.toHexString());
    return {
      name: record.name,
      above: folder ? [...folder.ancestorIds, folder._id] : [record.folderId],
    };
  }

  private async createGrant(
    principal: Principal,
    input: PutGrantInput,
  ): Promise<AccessGrantDocument | null> {
    const tenantId = principal.tenantId;
    const userId = toObjectId(input.userId);
    if ((await this.grants.count(tenantId, { userId })) >= MAX_GRANTS_PER_USER) throw grantLimit();
    try {
      return await this.grants.create(tenantId, {
        ...grantKey(input),
        level: input.level,
        createdBy: toObjectId(principal.userId),
        createdByName: principal.displayName,
      });
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
  }

  private async confirmCreated(
    tenantId: string,
    input: PutGrantInput,
    grant: AccessGrantDocument,
  ): Promise<void> {
    try {
      await this.requireLiveTarget(tenantId, input.targetType, input.targetId);
      await this.requireGrantee(tenantId, input.userId);
      const held = await this.grants.count(tenantId, { userId: toObjectId(input.userId) });
      if (held > MAX_GRANTS_PER_USER) throw grantLimit();
    } catch (error) {
      await this.grants.deleteById(tenantId, idOf(grant));
      throw error;
    }
  }

  private async heldAfterRevoke(
    tenantId: string,
    revoked: AccessGrantDocument,
  ): Promise<Array<{ id: string; name: string }>> {
    const held = await this.records.find(
      tenantId,
      { checkedOutBy: revoked.userId, deletedAt: null },
      { sort: { name: 1 }, limit: HELD_CHECKOUTS_SCANNED },
    );
    if (held.length === 0) return [];
    const remaining = await this.grants.find(tenantId, { userId: revoked.userId });
    const [before, after] = await Promise.all([
      this.scopeOf(tenantId, [...remaining, revoked]),
      this.scopeOf(tenantId, remaining),
    ]);
    return held
      .filter(
        (record) =>
          atLeast(before.levelOfRecord(record), 'edit') &&
          !atLeast(after.levelOfRecord(record), 'edit'),
      )
      .map((record) => ({ id: idOf(record), name: record.name }));
  }

  private async views(tenantId: string, grants: readonly Doc<AccessGrant>[]): Promise<GrantView[]> {
    if (grants.length === 0) return [];
    const idsOf = (type: GrantTargetType) => [
      ...new Set(grants.filter((g) => g.targetType === type).map((g) => g.targetId.toHexString())),
    ];
    const folderIds = idsOf('folder');
    const recordIds = idsOf('record');
    const userIds = [...new Set(grants.map((g) => g.userId.toHexString()))];
    const [users, folders, records] = await Promise.all([
      this.users.find(tenantId, { _id: { $in: userIds.map(toObjectId) } }),
      folderIds.length === 0
        ? Promise.resolve([])
        : this.folders.find(tenantId, { _id: { $in: folderIds.map(toObjectId) } }),
      recordIds.length === 0
        ? Promise.resolve([])
        : this.records.find(tenantId, { _id: { $in: recordIds.map(toObjectId) } }),
    ]);
    const userNames = new Map(users.map((u) => [idOf(u), u.displayName]));
    const targetNames = new Map<string, string>([
      ...folders.map((f): [string, string] => [`folder:${idOf(f)}`, f.name]),
      ...records.map((r): [string, string] => [`record:${idOf(r)}`, r.name]),
    ]);
    return grants.map((grant) => {
      const targetId = grant.targetId.toHexString();
      return {
        id: idOf(grant),
        userId: grant.userId.toHexString(),
        userName: userNames.get(grant.userId.toHexString()) ?? null,
        targetType: grant.targetType,
        targetId,
        targetName: targetNames.get(`${grant.targetType}:${targetId}`) ?? null,
        level: grant.level,
        createdBy: grant.createdBy.toHexString(),
        createdByName: grant.createdByName,
        createdAt: grant.createdAt.toISOString(),
        updatedAt: grant.updatedAt.toISOString(),
      };
    });
  }
}

function idString(id: ScopeGrant['targetId']): string {
  return typeof id === 'string' ? id : id.toHexString();
}
