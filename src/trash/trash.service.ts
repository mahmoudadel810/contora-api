import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Types } from 'mongoose';
import { atLeast } from '../access/access-scope.js';
import { AccessService } from '../access/access.service.js';
import { AiExtractionDataService } from '../ai-extraction/ai-extraction-data.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CommentsService } from '../comments/comments.service.js';
import { MyRecordsService } from '../my-records/my-records.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { AppError, errors } from '../common/errors.js';
import { toObjectId } from '../database/object-id.js';
import type { FolderDocument } from '../folders/folder.schema.js';
import { FoldersRepository } from '../folders/folders.repository.js';
import { FoldersService } from '../folders/folders.service.js';
import type { RecordDocument } from '../records/record.schema.js';
import type { PersonRef, RecordView, TrashedRecordView } from '../records/record.view.js';
import { RecordsRepository, VersionsRepository } from '../records/records.repository.js';
import { NOT_CHECKED_OUT, RecordState } from '../records/record-state.js';
import { RecordsService } from '../records/records.service.js';
import { RelationsService } from '../relations/relations.service.js';
import { ShareLinksService } from '../shares/share-links.service.js';
import { BlobsService } from '../storage/blobs.service.js';

export interface TrashedFolderView {
  id: string;
  name: string;
  deletedAt: string;
  deletedBy: PersonRef | null;
  folderCount: number;
  recordCount: number;
}

export interface TrashView {
  folders: TrashedFolderView[];
  records: TrashedRecordView[];
}

export interface PurgeResult {
  records: number;
  versions: number;
  blobsReleased: number;
}

export const STALE_PURGE_CLAIM_MS = 10 * 60 * 1000;

function claimable() {
  return {
    $or: [
      { purgeToken: null },
      { purgeClaimedAt: null },
      { purgeClaimedAt: { $lt: new Date(Date.now() - STALE_PURGE_CLAIM_MS) } },
    ],
  };
}

function deletedByOf(entity: {
  deletedBy: Types.ObjectId | null;
  deletedByName: string | null;
}): PersonRef | null {
  return entity.deletedBy
    ? { id: entity.deletedBy.toHexString(), displayName: entity.deletedByName ?? '' }
    : null;
}

@Injectable()
export class TrashService {
  constructor(
    private readonly records: RecordsRepository,
    private readonly versions: VersionsRepository,
    private readonly recordsService: RecordsService,
    private readonly recordState: RecordState,
    private readonly folders: FoldersRepository,
    private readonly foldersService: FoldersService,
    private readonly blobs: BlobsService,
    private readonly comments: CommentsService,
    private readonly myRecords: MyRecordsService,
    private readonly notifications: NotificationsService,
    private readonly relations: RelationsService,
    private readonly shareLinks: ShareLinksService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly aiExtractions: AiExtractionDataService,
  ) {}

  async trashRecord(principal: Principal, id: string): Promise<void> {
    await this.policy.authorize(principal, 'records.trash', { type: 'record', id });
    const { before: record } = await this.recordState.trash(principal, id);
    await this.audit.record(principal.tenantId, {
      action: 'RECORD_TRASHED',
      actor: actorOf(principal),
      resource: { type: 'record', id, label: record.name },
      context: { folderId: record.folderId.toHexString() },
    });
  }

  async trashFolder(principal: Principal, id: string): Promise<void> {
    await this.policy.authorize(principal, 'folders.trash', { type: 'folder', id });
    const tenantId = principal.tenantId;
    const folder = await this.access.requireFolder(principal, id, 'edit', { itself: true });
    if (folder.isRoot) throw errors.badRequest('ROOT_FOLDER', 'The root folder cannot be deleted');
    const folderIds = await this.foldersService.liveSubtreeIds(tenantId, id);
    const lockedByOther = {
      folderId: { $in: folderIds },
      deletedAt: null,
      ...this.recordState.heldByOther(principal),
    };
    const locked = await this.records.findOne(tenantId, lockedByOther);
    if (locked) throw this.recordState.heldInFolderError(locked);
    const batch = randomUUID();
    const stamp = {
      deletedAt: new Date(),
      deletedBy: toObjectId(principal.userId),
      deletedByName: principal.displayName,
      trashBatchId: batch,
    };
    await this.folders.updateMany(tenantId, { _id: { $in: folderIds }, deletedAt: null }, stamp);
    const recordCount = await this.records.updateMany(
      tenantId,
      { folderId: { $in: folderIds }, deletedAt: null, ...this.recordState.lockFree(principal) },
      stamp,
    );
    const lockedMeanwhile = await this.records.findOne(tenantId, lockedByOther);
    if (lockedMeanwhile) {
      const unstamp = { deletedAt: null, deletedBy: null, deletedByName: null, trashBatchId: null };
      const ours = { trashBatchId: batch, purgeToken: null };
      await this.records.updateMany(tenantId, ours, unstamp);
      await this.folders.updateMany(tenantId, ours, unstamp);
      throw this.recordState.heldInFolderError(lockedMeanwhile);
    }
    await this.folders.updateById(tenantId, id, { trashRoot: true });
    await this.records.updateMany(
      tenantId,
      { trashBatchId: batch, checkedOutBy: { $ne: null } },
      NOT_CHECKED_OUT,
    );
    await this.audit.record(tenantId, {
      action: 'FOLDER_TRASHED',
      actor: actorOf(principal),
      resource: { type: 'folder', id, label: folder.name },
      context: { folders: folderIds.length, records: recordCount },
    });
  }

  async list(principal: Principal): Promise<TrashView> {
    await this.policy.authorize(principal, 'trash.read');
    const tenantId = principal.tenantId;
    const scope = await this.access.scopeFor(principal);
    const [trashedFolders, trashedRecords] = await Promise.all([
      this.folders.find(
        tenantId,
        { $and: [{ trashRoot: true, deletedAt: { $ne: null } }, scope.folderFilter('edit')] },
        { sort: { deletedAt: -1 } },
      ),
      this.records.find(
        tenantId,
        { $and: [{ deletedAt: { $ne: null } }, scope.recordFilter('edit')] },
        { sort: { deletedAt: -1 }, limit: 500 },
      ),
    ]);
    const folderBatches = new Set(trashedFolders.map((f) => f.trashBatchId));
    const folders = await Promise.all(
      trashedFolders.map(async (folder) => ({
        id: folder.id,
        name: folder.name,
        deletedAt: (folder.deletedAt as Date).toISOString(),
        deletedBy: deletedByOf(folder),
        folderCount: await this.folders.count(tenantId, { trashBatchId: folder.trashBatchId }),
        recordCount: await this.records.count(tenantId, { trashBatchId: folder.trashBatchId }),
      })),
    );
    const views = await this.recordsService.withNames(tenantId, trashedRecords, scope);
    const records = trashedRecords.map((record, index) => ({
      ...(views[index] as RecordView),
      deletedAt: (record.deletedAt as Date).toISOString(),
      deletedBy: deletedByOf(record),
      trashedWithFolder: folderBatches.has(record.trashBatchId),
    }));
    return { folders, records };
  }

  async restoreRecord(principal: Principal, id: string): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.trash', { type: 'record', id });
    const tenantId = principal.tenantId;
    const scope = await this.access.scopeFor(principal);
    const record = await this.access.requireRecord(principal, id, 'edit', {
      trashed: true,
      what: 'Trashed record',
    });
    const folder = await this.folders.findById(tenantId, record.folderId.toHexString());
    let target = folder;
    if (!folder || folder.deletedAt) {
      const root = await this.foldersService.ensureRoot(principal);
      if (!atLeast(scope.levelOfFolder(root), 'edit')) {
        throw errors.conflict('PARENT_IN_TRASH', 'Restore the record’s folder first');
      }
      target = root;
    }
    const destination = target as FolderDocument;
    const restored = await this.records.updateOne(
      tenantId,
      { _id: record._id, deletedAt: { $ne: null }, purgeToken: null },
      {
        deletedAt: null,
        deletedBy: null,
        deletedByName: null,
        trashBatchId: null,
        folderId: destination._id,
      },
    );
    if (!restored) throw errors.notFound('Trashed record');
    await this.audit.record(tenantId, {
      action: 'RECORD_RESTORED',
      actor: actorOf(principal),
      resource: { type: 'record', id, label: record.name },
      context: {
        folderId: destination.id as string,
        movedToRoot: !destination._id.equals(record.folderId),
      },
    });
    return (await this.recordsService.withNames(tenantId, [restored], scope))[0];
  }

  async restoreFolder(principal: Principal, id: string): Promise<void> {
    await this.policy.authorize(principal, 'folders.trash', { type: 'folder', id });
    const tenantId = principal.tenantId;
    const folder = await this.access.requireFolder(principal, id, 'edit', {
      trashed: true,
      what: 'Trashed folder',
    });
    if (!folder.trashRoot) throw errors.notFound('Trashed folder');
    const parent = folder.parentId
      ? await this.folders.findById(tenantId, folder.parentId.toHexString())
      : null;
    if (!parent || parent.deletedAt) {
      throw errors.conflict('PARENT_IN_TRASH', 'Restore the parent folder first');
    }
    await this.foldersService.assertNameFree(tenantId, parent._id, folder.name);
    const cleared = { deletedAt: null, deletedBy: null, deletedByName: null, trashBatchId: null };
    const restored = await this.folders.updateOne(
      tenantId,
      { _id: folder._id, deletedAt: { $ne: null }, trashRoot: true, purgeToken: null },
      { ...cleared, trashRoot: false },
    );
    if (!restored) throw errors.notFound('Trashed folder');
    const batch = { trashBatchId: folder.trashBatchId, purgeToken: null };
    await this.folders.updateMany(tenantId, batch, { ...cleared, trashRoot: false });
    const records = await this.records.updateMany(tenantId, batch, cleared);
    await this.audit.record(tenantId, {
      action: 'FOLDER_RESTORED',
      actor: actorOf(principal),
      resource: { type: 'folder', id, label: folder.name },
      context: { records },
    });
  }

  async purgeRecord(principal: Principal, id: string): Promise<PurgeResult> {
    await this.policy.authorize(principal, 'trash.purge', { type: 'record', id });
    const record = await this.requireTrashedRecord(principal.tenantId, id);
    const { result, grantsRemoved } = await this.purge(
      principal.tenantId,
      [record._id],
      randomUUID(),
    );
    if (result.records === 0) throw errors.notFound('Trashed record');
    await this.audit.record(principal.tenantId, {
      action: 'RECORD_PURGED',
      actor: actorOf(principal),
      resource: { type: 'record', id, label: record.name },
      context: { ...result, grantsRemoved },
    });
    return result;
  }

  async purgeFolder(principal: Principal, id: string): Promise<PurgeResult> {
    await this.policy.authorize(principal, 'trash.purge', { type: 'folder', id });
    const tenantId = principal.tenantId;
    const folder = await this.requireTrashedFolder(tenantId, id);
    const token = randomUUID();
    const claimed = await this.folders.updateOne(
      tenantId,
      { _id: folder._id, deletedAt: { $ne: null }, trashRoot: true, ...claimable() },
      { purgeToken: token, purgeClaimedAt: new Date() },
    );
    if (!claimed) throw errors.notFound('Trashed folder');
    const nested = await this.folders.find(tenantId, {
      trashRoot: true,
      deletedAt: { $ne: null },
      ancestorIds: folder._id,
      ...claimable(),
    });
    const batchIds = [folder.trashBatchId, ...nested.map((f) => f.trashBatchId)];
    await this.folders.updateMany(
      tenantId,
      { trashBatchId: { $in: batchIds }, deletedAt: { $ne: null }, ...claimable() },
      { purgeToken: token, purgeClaimedAt: new Date() },
    );
    const claimedFolders = { trashBatchId: { $in: batchIds }, purgeToken: token };
    const folderIds = (await this.folders.find(tenantId, claimedFolders)).map((f) => f._id);
    const folderGrants = await this.access.purgeForTargets(tenantId, { folderIds });
    const records = await this.records.find(tenantId, {
      deletedAt: { $ne: null },
      $or: [{ trashBatchId: { $in: batchIds } }, { folderId: { $in: folderIds } }],
    });
    const { result, grantsRemoved } = await this.purge(
      tenantId,
      records.map((r) => r._id),
      token,
    );
    const folders = await this.folders.deleteMany(tenantId, claimedFolders);
    await this.audit.record(tenantId, {
      action: 'FOLDER_PURGED',
      actor: actorOf(principal),
      resource: { type: 'folder', id, label: folder.name },
      context: { ...result, folders, grantsRemoved: grantsRemoved + folderGrants },
    });
    return result;
  }

  async empty(principal: Principal): Promise<PurgeResult> {
    await this.policy.authorize(principal, 'trash.purge', { type: 'trash' });
    const tenantId = principal.tenantId;
    const trashed = await this.folders.find(tenantId, {
      trashRoot: true,
      deletedAt: { $ne: null },
    });
    const total: PurgeResult = { records: 0, versions: 0, blobsReleased: 0 };
    const add = (result: PurgeResult) => {
      total.records += result.records;
      total.versions += result.versions;
      total.blobsReleased += result.blobsReleased;
    };
    for (const folder of trashed) {
      if (!(await this.folders.findById(tenantId, folder.id))) continue;
      add(await this.unlessGone(() => this.purgeFolder(principal, folder.id)));
    }
    for (const record of await this.records.find(tenantId, { deletedAt: { $ne: null } })) {
      add(await this.unlessGone(() => this.purgeRecord(principal, record.id)));
    }
    return total;
  }

  private async purge(
    tenantId: string,
    candidateIds: Types.ObjectId[],
    token: string,
  ): Promise<{ result: PurgeResult; grantsRemoved: number }> {
    const none = { result: { records: 0, versions: 0, blobsReleased: 0 }, grantsRemoved: 0 };
    if (candidateIds.length === 0) return none;
    await this.records.updateMany(
      tenantId,
      { _id: { $in: candidateIds }, deletedAt: { $ne: null }, ...claimable() },
      { purgeToken: token, purgeClaimedAt: new Date() },
    );
    const recordIds = (await this.records.distinct(tenantId, '_id', {
      _id: { $in: candidateIds },
      purgeToken: token,
    })) as Types.ObjectId[];
    if (recordIds.length === 0) return none;
    const grantsRemoved = await this.access.purgeForTargets(tenantId, { recordIds });
    const blobIds = (await this.versions.distinct(tenantId, 'file.blobId', {
      recordId: { $in: recordIds },
    })) as Types.ObjectId[];
    const versions = await this.versions.deleteMany(tenantId, { recordId: { $in: recordIds } });
    await this.comments.purgeForRecords(tenantId, recordIds);
    await this.myRecords.purgeForRecords(tenantId, recordIds);
    await this.notifications.purgeForRecords(tenantId, recordIds);
    await this.shareLinks.purgeForRecords(tenantId, recordIds);
    await this.relations.purgeForRecords(tenantId, recordIds);
    await this.aiExtractions.purgeForRecords(tenantId, recordIds);
    const removed = await this.records.deleteMany(tenantId, {
      _id: { $in: recordIds },
      purgeToken: token,
    });
    const blobsReleased = await this.blobs.releaseUnreferenced(tenantId, blobIds.filter(Boolean));
    await this.blobs.sweepUnreferenced(tenantId);
    return { result: { records: removed, versions, blobsReleased }, grantsRemoved };
  }

  private async unlessGone(run: () => Promise<PurgeResult>): Promise<PurgeResult> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppError && error.getStatus() === 404) {
        return { records: 0, versions: 0, blobsReleased: 0 };
      }
      throw error;
    }
  }

  private async requireTrashedRecord(tenantId: string, id: string): Promise<RecordDocument> {
    const record = await this.records.findById(tenantId, id);
    if (!record || !record.deletedAt) throw errors.notFound('Trashed record');
    return record;
  }

  private async requireTrashedFolder(tenantId: string, id: string): Promise<FolderDocument> {
    const folder = await this.folders.findById(tenantId, id);
    if (!folder || !folder.deletedAt || !folder.trashRoot) throw errors.notFound('Trashed folder');
    return folder;
  }
}
