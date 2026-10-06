import type { QueryFilter, Types } from 'mongoose';
import { toObjectId } from '../database/object-id.js';
import type { Folder } from '../folders/folder.schema.js';
import type { RecordEntity } from '../records/record.schema.js';

export const ACCESS_LEVELS = ['view', 'edit'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const GRANT_TARGET_TYPES = ['folder', 'record'] as const;
export type GrantTargetType = (typeof GRANT_TARGET_TYPES)[number];

export type IdLike = string | { toHexString(): string };

export interface ScopeGrant {
  targetType: GrantTargetType;
  targetId: IdLike;
  level: AccessLevel;
}

export interface ScopeFolder {
  _id: IdLike;
  parentId: IdLike | null;
  ancestorIds: readonly IdLike[];
}

export interface ScopeRecord {
  _id: IdLike;
  folderId: IdLike;
}

export interface ScopeCrumb {
  id: string;
  name: string;
}

export interface EntryPoint {
  type: GrantTargetType;
  id: string;
  level: AccessLevel;
}

const RANK: Record<AccessLevel, number> = { view: 1, edit: 2 };

function hexOf(id: IdLike): string {
  return typeof id === 'string' ? id : id.toHexString();
}

export function atLeast(level: AccessLevel | null, min: AccessLevel): boolean {
  return level !== null && RANK[level] >= RANK[min];
}

export function maxLevel(a: AccessLevel | null, b: AccessLevel | null): AccessLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export interface FolderPin {
  folderId: Types.ObjectId;
}

function nothing() {
  return { _id: { $in: [] } };
}

export class AccessScope {
  private constructor(
    readonly unrestricted: boolean,
    private readonly folderGrants: ReadonlyMap<string, AccessLevel>,
    private readonly recordGrants: ReadonlyMap<string, AccessLevel>,
    private readonly folders: ReadonlyMap<string, ScopeFolder>,
    private readonly rootLevel: AccessLevel | null,
  ) {}

  static unrestricted(): AccessScope {
    return new AccessScope(true, new Map(), new Map(), new Map(), 'edit');
  }

  static none(): AccessScope {
    return AccessScope.fromGrants([], []);
  }

  static fromGrants(
    grants: readonly ScopeGrant[],
    folders: readonly ScopeFolder[],
    rootId: IdLike | null = null,
  ): AccessScope {
    const folderGrants = new Map<string, AccessLevel>();
    const recordGrants = new Map<string, AccessLevel>();
    for (const grant of grants) {
      const target = grant.targetType === 'folder' ? folderGrants : recordGrants;
      const key = hexOf(grant.targetId);
      target.set(key, maxLevel(target.get(key) ?? null, grant.level) as AccessLevel);
    }
    const root = rootId === null ? null : hexOf(rootId);
    return new AccessScope(
      false,
      folderGrants,
      recordGrants,
      new Map(folders.map((folder) => [hexOf(folder._id), folder])),
      root === null ? null : (folderGrants.get(root) ?? null),
    );
  }

  levelOfFolder(folder: Pick<ScopeFolder, '_id' | 'ancestorIds'>): AccessLevel | null {
    if (this.unrestricted) return 'edit';
    return maxLevel(this.inherited(folder), this.folderGrants.get(hexOf(folder._id)) ?? null);
  }

  levelOfFolderItself(folder: Pick<ScopeFolder, 'ancestorIds'>): AccessLevel | null {
    if (this.unrestricted) return 'edit';
    return this.inherited(folder);
  }

  levelOfFolderId(folderId: IdLike): AccessLevel | null {
    if (this.unrestricted) return 'edit';
    const folder = this.folders.get(hexOf(folderId));
    return folder ? this.levelOfFolder(folder) : this.rootLevel;
  }

  levelOfRecord(record: ScopeRecord): AccessLevel | null {
    if (this.unrestricted) return 'edit';
    return maxLevel(this.recordGrant(record), this.levelOfFolderId(record.folderId));
  }

  recordFilter(min: AccessLevel): QueryFilter<RecordEntity> {
    if (this.unrestricted || atLeast(this.rootLevel, min)) return {};
    const folderIds = this.folderIdsAt(min);
    const recordIds = this.recordIdsAt(min);
    if (folderIds.length === 0 && recordIds.length === 0)
      return nothing() as QueryFilter<RecordEntity>;
    return {
      $or: [{ folderId: { $in: folderIds } }, { _id: { $in: recordIds } }],
    } as QueryFilter<RecordEntity>;
  }

  folderFilter(min: AccessLevel): QueryFilter<Folder> {
    if (this.unrestricted || atLeast(this.rootLevel, min)) return {};
    const ids = this.folderIdsAt(min);
    return (ids.length === 0 ? nothing() : { _id: { $in: ids } }) as QueryFilter<Folder>;
  }

  pinFor(record: ScopeRecord, min: AccessLevel): FolderPin | null {
    if (this.unrestricted || atLeast(this.recordGrant(record), min)) return null;
    return { folderId: toObjectId(hexOf(record.folderId)) };
  }

  trimCrumbs<T extends ScopeCrumb>(crumbs: readonly T[]): T[] {
    if (this.unrestricted) return [...crumbs];
    return crumbs.filter((crumb) => this.levelOfFolderId(crumb.id) !== null);
  }

  visibleParentId(folder: ScopeFolder): string | null {
    if (folder.parentId === null) return null;
    if (!this.unrestricted && this.inherited(folder) === null) return null;
    return hexOf(folder.parentId);
  }

  entryPoints(grantedRecords: readonly ScopeRecord[] = []): EntryPoint[] {
    if (this.unrestricted) return [];
    const points: EntryPoint[] = [];
    for (const id of this.folderGrants.keys()) {
      const folder = this.folders.get(id);
      if (!folder || this.inherited(folder) !== null) continue;
      points.push({ type: 'folder', id, level: this.levelOfFolder(folder) as AccessLevel });
    }
    const records = new Map(grantedRecords.map((record) => [hexOf(record._id), record]));
    for (const [id, level] of this.recordGrants) {
      const record = records.get(id);
      if (!record || this.levelOfFolderId(record.folderId) !== null) continue;
      points.push({ type: 'record', id, level });
    }
    return points;
  }

  private inherited(folder: Pick<ScopeFolder, 'ancestorIds'>): AccessLevel | null {
    let level: AccessLevel | null = null;
    for (const ancestorId of folder.ancestorIds) {
      level = maxLevel(level, this.folderGrants.get(hexOf(ancestorId)) ?? null);
    }
    return level;
  }

  private recordGrant(record: ScopeRecord): AccessLevel | null {
    return this.recordGrants.get(hexOf(record._id)) ?? null;
  }

  private folderIdsAt(min: AccessLevel): Types.ObjectId[] {
    return [...this.folders.entries()]
      .filter(([, folder]) => atLeast(this.levelOfFolder(folder), min))
      .map(([id]) => toObjectId(id));
  }

  private recordIdsAt(min: AccessLevel): Types.ObjectId[] {
    return [...this.recordGrants.entries()]
      .filter(([, level]) => atLeast(level, min))
      .map(([id]) => toObjectId(id));
  }
}
