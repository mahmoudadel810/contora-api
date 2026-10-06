import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Types, type QueryFilter } from 'mongoose';
import type { AccessLevel, AccessScope } from '../access/access-scope.js';
import { AccessService, type ScopeOptions } from '../access/access.service.js';
import type { Principal } from '../auth/principal.js';
import { isDuplicateKey } from '../common/duplicate-key.js';
import { errors, type AppError } from '../common/errors.js';
import type { ContentTypeDocument } from '../content-types/content-type.schema.js';
import { ContentTypesService } from '../content-types/content-types.service.js';
import { toObjectId } from '../database/object-id.js';
import type { FileRef } from '../storage/blob.schema.js';
import { searchTextOf } from './metadata.js';
import type { RecordDocument, RecordEntity } from './record.schema.js';
import type { RecordVersionDocument } from './record-version.schema.js';
import { RecordsRepository, VersionsRepository } from './records.repository.js';
import { textKeyUpdate, versionKeyUpdate } from './search-keys.js';

const MAX_VERSION_ATTEMPTS = 8;
const MAX_TAG_ATTEMPTS = 5;
const MAX_TAGS = 20;

export const NOT_CHECKED_OUT = { checkedOutBy: null, checkedOutByName: null, checkedOutAt: null };

export interface RecordTransition {
  before: RecordDocument;
  after: RecordDocument;
  changed: boolean;
}

export type TagChange = { set: string[] } | { add: string[]; remove: string[] };

export interface VersionContent {
  file: FileRef | null;
  metadata: Record<string, unknown>;
  schemaVersion: number;
  comment: string;
  restoredFrom: number | null;
}

@Injectable()
export class RecordState {
  constructor(
    private readonly records: RecordsRepository,
    private readonly versions: VersionsRepository,
    private readonly contentTypes: ContentTypesService,
    private readonly access: AccessService,
  ) {}

  async requireLive(tenantId: string, id: string): Promise<RecordDocument> {
    const record = await this.records.findById(tenantId, id);
    if (!record || record.deletedAt) throw errors.notFound('Record');
    return record;
  }

  async requireWritable(
    principal: Principal,
    id: string,
    options: ScopeOptions = {},
  ): Promise<RecordDocument> {
    const scope = await this.access.scopeFor(principal, options);
    const record = await this.requireLive(principal.tenantId, id);
    await this.assertAccess(principal, scope, record, 'edit');
    this.assertWritable(principal, record);
    return record;
  }

  async rename(principal: Principal, id: string, name: string): Promise<RecordTransition> {
    const record = await this.requireWritable(principal, id);
    const scope = await this.access.scopeFor(principal);
    const fields = await this.fieldsOf(principal, record);
    const searchText = searchTextOf(
      name,
      fields,
      record.metadata,
      record.file?.fileName ?? null,
      record.tags,
    );
    const after = await this.records.updateOne(
      principal.tenantId,
      this.writable(principal, record, scope),
      {
        name,
        searchText,
        ...textKeyUpdate(searchText),
        updatedBy: toObjectId(principal.userId),
        updatedByName: principal.displayName,
      },
    );
    if (!after) throw await this.refusal(principal, id, scope);
    return { before: record, after, changed: true };
  }

  async retag(principal: Principal, id: string, change: TagChange): Promise<RecordTransition> {
    const relative = !('set' in change);
    const scope = await this.access.scopeFor(principal);
    for (let attempt = 0; attempt < MAX_TAG_ATTEMPTS; attempt += 1) {
      const record = await this.requireLive(principal.tenantId, id);
      await this.assertAccess(principal, scope, record, 'edit');
      const tags = 'set' in change ? change.set : applyTagChange(record.tags, change);
      if (tags.length > MAX_TAGS) {
        throw errors.badRequest('TOO_MANY_TAGS', `A record can have at most ${MAX_TAGS} tags`);
      }
      if (relative && sameTags(tags, record.tags)) {
        return { before: record, after: record, changed: false };
      }
      this.assertWritable(principal, record);
      const fields = await this.fieldsOf(principal, record);
      const searchText = searchTextOf(
        record.name,
        fields,
        record.metadata,
        record.file?.fileName ?? null,
        tags,
      );
      const after = await this.records.updateOne(
        principal.tenantId,
        relative
          ? { ...this.writable(principal, record, scope), tags: tagsAsRead(record.tags) }
          : this.writable(principal, record, scope),
        { tags, searchText, ...textKeyUpdate(searchText) },
      );
      if (after) return { before: record, after, changed: true };
      const refusal = await this.refusal(principal, id, scope);
      if (!relative || refusal.code !== 'WRITE_CONFLICT') throw refusal;
    }
    throw writeConflict();
  }

  async commitVersion(
    principal: Principal,
    record: RecordDocument,
    type: ContentTypeDocument,
    content: VersionContent,
  ): Promise<RecordVersionDocument> {
    const tenantId = principal.tenantId;
    if (!record.tenantId.equals(tenantId)) throw errors.notFound('Record');
    let version: RecordVersionDocument | null = null;
    for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS && !version; attempt += 1) {
      const latest = await this.versions.latest(tenantId, record._id);
      try {
        version = await this.versions.createWithId(tenantId, new Types.ObjectId(), {
          recordId: record._id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          file: content.file,
          metadata: content.metadata,
          schemaVersion: content.schemaVersion,
          comment: content.comment,
          restoredFrom: content.restoredFrom,
          createdBy: toObjectId(principal.userId),
          createdByName: principal.displayName,
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    if (!version) {
      throw errors.conflict('VERSION_CONFLICT', 'Too many concurrent versions; please retry');
    }
    const scope = await this.access.scopeFor(principal);
    const searchText = searchTextOf(
      record.name,
      type.fields,
      content.metadata,
      content.file?.fileName ?? null,
      record.tags,
    );
    const committed = await this.records.updateOne(
      tenantId,
      {
        ...this.writable(principal, record, scope),
        currentVersion: { $lt: version.versionNumber },
      },
      {
        currentVersion: version.versionNumber,
        currentVersionId: version._id,
        file: content.file,
        metadata: content.metadata,
        schemaVersion: content.schemaVersion,
        searchText,
        ...versionKeyUpdate(searchText, content.metadata),
        updatedBy: toObjectId(principal.userId),
        updatedByName: principal.displayName,
      },
    );
    if (!committed) {
      const refusal = await this.refusal(principal, record.id, scope);
      if (refusal.code !== 'WRITE_CONFLICT') {
        await this.versions.deleteById(tenantId, version.id);
        throw refusal;
      }
    }
    return version;
  }

  async trash(principal: Principal, id: string): Promise<RecordTransition> {
    const record = await this.requireWritable(principal, id);
    const scope = await this.access.scopeFor(principal);
    const after = await this.records.updateOne(
      principal.tenantId,
      this.writable(principal, record, scope),
      {
        deletedAt: new Date(),
        deletedBy: toObjectId(principal.userId),
        deletedByName: principal.displayName,
        trashBatchId: randomUUID(),
        ...NOT_CHECKED_OUT,
      },
    );
    if (!after) throw await this.refusal(principal, id, scope);
    return { before: record, after, changed: true };
  }

  async checkOut(principal: Principal, id: string): Promise<RecordTransition> {
    const scope = await this.access.scopeFor(principal);
    const record = await this.requireLive(principal.tenantId, id);
    await this.assertAccess(principal, scope, record, 'edit');
    const after = await this.records.updateOne(
      principal.tenantId,
      { _id: record._id, deletedAt: null, checkedOutBy: null, ...this.pin(scope, record) },
      {
        checkedOutBy: toObjectId(principal.userId),
        checkedOutByName: principal.displayName,
        checkedOutAt: new Date(),
      },
    );
    if (after) return { before: record, after, changed: true };
    const current = await this.requireLive(principal.tenantId, id);
    await this.assertAccess(principal, scope, current, 'edit');
    if (current.checkedOutBy?.equals(principal.userId)) {
      return { before: current, after: current, changed: false };
    }
    if (!current.checkedOutBy) throw writeConflict();
    throw lockedError(current);
  }

  async release(
    principal: Principal,
    id: string,
    mode: 'checkIn' | 'force',
  ): Promise<RecordTransition> {
    const scope = await this.access.scopeFor(principal);
    const record = await this.requireLive(principal.tenantId, id);
    await this.assertAccess(principal, scope, record, 'edit');
    if (!record.checkedOutBy) throw notCheckedOut();
    if (mode === 'checkIn' && !record.checkedOutBy.equals(principal.userId)) {
      throw lockedError(record);
    }
    const after = await this.records.updateOne(
      principal.tenantId,
      {
        _id: record._id,
        deletedAt: null,
        checkedOutBy: record.checkedOutBy,
        ...this.pin(scope, record),
      },
      NOT_CHECKED_OUT,
    );
    if (after) return { before: record, after, changed: true };
    const current = await this.requireLive(principal.tenantId, id);
    await this.assertAccess(principal, scope, current, 'edit');
    if (!current.checkedOutBy) throw notCheckedOut();
    if (current.checkedOutBy.equals(record.checkedOutBy)) throw writeConflict();
    throw lockedError(current);
  }

  lockFree(principal: Principal): QueryFilter<RecordEntity> {
    return { checkedOutBy: { $in: [null, toObjectId(principal.userId)] } };
  }

  heldByOther(principal: Principal): QueryFilter<RecordEntity> {
    return { checkedOutBy: { $nin: [null, toObjectId(principal.userId)] } };
  }

  heldInFolderError(record: RecordDocument): AppError {
    return errors.conflict(
      'RECORD_CHECKED_OUT',
      `"${record.name}" is checked out by ${record.checkedOutByName ?? 'another user'}`,
    );
  }

  private assertWritable(principal: Principal, record: RecordDocument): void {
    if (record.checkedOutBy && !record.checkedOutBy.equals(principal.userId)) {
      throw lockedError(record);
    }
  }

  private assertAccess(
    principal: Principal,
    scope: AccessScope,
    record: RecordDocument,
    min: AccessLevel,
  ): Promise<void> {
    return this.access.assertLevel(principal, resourceOf(record), scope.levelOfRecord(record), min);
  }

  private pin(scope: AccessScope, record: RecordDocument): QueryFilter<RecordEntity> {
    return scope.pinFor(record, 'edit') ?? {};
  }

  private writable(
    principal: Principal,
    record: RecordDocument,
    scope: AccessScope,
  ): QueryFilter<RecordEntity> {
    return {
      _id: record._id,
      deletedAt: null,
      ...this.lockFree(principal),
      ...this.pin(scope, record),
    };
  }

  private async refusal(principal: Principal, id: string, scope: AccessScope): Promise<AppError> {
    const record = await this.records.findById(principal.tenantId, id);
    if (!record || record.deletedAt) return errors.notFound('Record');
    const denied = await this.access.refusalFor(
      principal,
      resourceOf(record),
      scope.levelOfRecord(record),
      'edit',
    );
    if (denied) return denied;
    if (record.checkedOutBy && !record.checkedOutBy.equals(principal.userId)) {
      return lockedError(record);
    }
    return writeConflict();
  }

  private async fieldsOf(principal: Principal, record: RecordDocument) {
    const type = await this.contentTypes.require(
      principal.tenantId,
      record.contentTypeId.toHexString(),
    );
    return type.fields;
  }
}

function applyTagChange(current: string[], change: { add: string[]; remove: string[] }): string[] {
  return [
    ...new Set([...current.filter((tag) => !change.remove.includes(tag)), ...change.add]),
  ].sort();
}

function sameTags(a: string[], b: string[]): boolean {
  return a.join('\u0000') === b.join('\u0000');
}

function tagsAsRead(tags: string[]): QueryFilter<RecordEntity>['tags'] {
  return tags.length > 0 ? [...tags] : { $in: [null, []] };
}

function lockedError(record: RecordDocument): AppError {
  return errors.conflict(
    'RECORD_CHECKED_OUT',
    `This record is checked out by ${record.checkedOutByName ?? 'another user'}`,
  );
}

function notCheckedOut(): AppError {
  return errors.conflict('NOT_CHECKED_OUT', 'This record is not checked out');
}

function writeConflict(): AppError {
  return errors.conflict('WRITE_CONFLICT', 'The record changed while saving; please retry');
}

function resourceOf(record: RecordDocument) {
  return { type: 'record', id: record.id as string, label: record.name };
}
