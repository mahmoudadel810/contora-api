import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { Types, type QueryFilter, type SortOrder } from 'mongoose';
import { atLeast, type AccessLevel, type AccessScope } from '../access/access-scope.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { actorOf, type Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors, type AppError } from '../common/errors.js';
import { isMaxTimeExpired } from '../common/max-time.js';
import { skipOf, toPage, type Page } from '../common/pagination.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import {
  toContentTypeView,
  type ContentTypeDocument,
} from '../content-types/content-type.schema.js';
import { ContentTypesRepository } from '../content-types/content-types.repository.js';
import {
  ContentTypesService,
  deletingError,
  isBeingDeleted,
} from '../content-types/content-types.service.js';
import { canonicalInstant, type FieldDefinition } from '../content-types/field-types.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import type { FolderDocument } from '../folders/folder.schema.js';
import { FoldersRepository } from '../folders/folders.repository.js';
import { FoldersService } from '../folders/folders.service.js';
import type { FileRef, FileRefView } from '../storage/blob.schema.js';
import { BlobsService, type UploadedFile } from '../storage/blobs.service.js';
import { DomainEvents } from '../events/domain-events.js';
import { UsersRepository } from '../users/users.repository.js';
import { csvRow } from './csv.js';
import { escapeRegex, validateMetadata } from './metadata.js';
import type { RecordDocument, RecordEntity } from './record.schema.js';
import type { RecordVersionDocument } from './record-version.schema.js';
import {
  toRecordView,
  toVersionView,
  type RecordDetailView,
  type RecordView,
  type VersionView,
} from './record.view.js';
import type {
  CreateRecordInput,
  ListRecordsQuery,
  MoveRecordInput,
  NewVersionInput,
  RenameRecordInput,
  RestoreVersionInput,
  SetTagsInput,
} from './records.dto.js';
import { RecordState, type RecordTransition } from './record-state.js';
import { RecordsRepository, VersionsRepository } from './records.repository.js';
import { foldedMetaCondition, indexedFields, META_KEY, searchCondition } from './search-keys.js';

const EXPORT_LIMIT = 5000;

interface SearchFilter {
  filter: QueryFilter<RecordEntity>;
  type: ContentTypeDocument | null;
  textual: boolean;
}

export interface OpenedFile {
  stream: Readable;
  file: FileRefView;
}

type RecordFilter = QueryFilter<RecordEntity>;

function exactMetadataValue(field: FieldDefinition | undefined, raw: string): unknown {
  if (!field) {
    const candidates: unknown[] = [raw];
    const numeric = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(numeric)) candidates.push(numeric);
    if (raw === 'true' || raw === 'false') candidates.push(raw === 'true');
    return { $in: candidates };
  }
  switch (field.type) {
    case 'phone':
      return { $regex: escapeRegex(raw), $options: 'i' };
    case 'number':
    case 'currency':
    case 'percentage': {
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : raw;
    }
    case 'datetime':
      return canonicalInstant(raw) ?? raw;
    case 'boolean':
      return raw === 'true';
    default:
      return raw;
  }
}

function metadataCondition(
  key: string,
  field: FieldDefinition | undefined,
  raw: string,
): { clause: RecordFilter | null; folded: boolean } {
  switch (field?.type) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'url':
      return { clause: foldedMetaCondition(key, raw), folded: true };
    default:
      return {
        clause: { [`metadata.${key}`]: exactMetadataValue(field, raw) } as RecordFilter,
        folded: false,
      };
  }
}

@Injectable()
export class RecordsService {
  constructor(
    private readonly records: RecordsRepository,
    private readonly versions: VersionsRepository,
    private readonly contentTypes: ContentTypesService,
    private readonly contentTypesRepository: ContentTypesRepository,
    private readonly users: UsersRepository,
    private readonly events: DomainEvents,
    private readonly folders: FoldersService,
    private readonly foldersRepository: FoldersRepository,
    private readonly blobs: BlobsService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly state: RecordState,
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    principal: Principal,
    input: CreateRecordInput,
    upload: UploadedFile | null,
  ): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', label: input.name });
    const tenantId = principal.tenantId;
    const type = await this.contentTypes.require(tenantId, input.contentTypeId);
    if (type.status === 'archived') {
      throw errors.conflict(
        'CONTENT_TYPE_ARCHIVED',
        'Archived content types do not accept new records',
      );
    }
    if (isBeingDeleted(type)) throw deletingError();
    const folder = await this.access.requireFolder(principal, input.folderId, 'edit');
    const metadata = validateMetadata(type.fields, input.metadata);
    await this.assertUsersActive(tenantId, type.fields, metadata);
    const file = upload ? await this.blobs.ingest(tenantId, upload) : null;
    return this.sweepingOnFailure(tenantId, file, async () => {
      if (upload) await this.folders.requireLive(tenantId, input.folderId);
      return this.insert(principal, input, type, folder, metadata, file);
    });
  }

  private async insert(
    principal: Principal,
    input: CreateRecordInput,
    type: ContentTypeDocument,
    folder: FolderDocument,
    metadata: Record<string, unknown>,
    file: FileRef | null,
  ): Promise<RecordView> {
    const tenantId = principal.tenantId;
    const recordId = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    const author = toObjectId(principal.userId);
    const record = await this.records.createWithId(tenantId, recordId, {
      name: input.name,
      contentTypeId: type._id,
      folderId: folder._id,
      currentVersion: 1,
      currentVersionId: versionId,
      metadata,
      schemaVersion: type.schemaVersion,
      file,
      ...indexedFields(input.name, type.fields, metadata, file?.fileName ?? null, input.tags),
      tags: input.tags,
      createdBy: author,
      createdByName: principal.displayName,
      updatedBy: author,
      updatedByName: principal.displayName,
      checkedOutBy: null,
      checkedOutByName: null,
      checkedOutAt: null,
      deletedAt: null,
      deletedBy: null,
      deletedByName: null,
      trashBatchId: null,
      purgeToken: null,
      purgeClaimedAt: null,
    });
    try {
      await this.versions.createWithId(tenantId, versionId, {
        recordId,
        versionNumber: 1,
        file,
        metadata,
        schemaVersion: type.schemaVersion,
        comment: input.comment || 'Initial version',
        restoredFrom: null,
        createdBy: author,
        createdByName: principal.displayName,
      });
    } catch (error) {
      await this.records.deleteById(tenantId, record.id);
      throw error;
    }
    const [current, currentFolder, scope] = await Promise.all([
      this.contentTypesRepository.findById(tenantId, input.contentTypeId),
      this.foldersRepository.findById(tenantId, folder.id),
      this.access.scopeFor(principal, { fresh: true }),
    ]);
    let refusal: AppError | null = null;
    if (!current) refusal = errors.notFound('Content type');
    else if (isBeingDeleted(current)) refusal = deletingError();
    else if (!currentFolder || currentFolder.deletedAt) refusal = errors.notFound('Folder');
    else if (!atLeast(scope.levelOfFolder(currentFolder), 'edit')) {
      refusal = errors.notFound('Folder');
    }
    if (refusal) {
      await this.versions.deleteById(tenantId, versionId.toHexString());
      await this.records.deleteById(tenantId, record.id);
      throw refusal;
    }
    await this.audit.record(tenantId, {
      action: 'RECORD_CREATED',
      actor: actorOf(principal),
      resource: { type: 'record', id: record.id, label: record.name },
      context: {
        contentType: type.name,
        folderId: folder.id,
        version: 1,
        file: file ? { name: file.fileName, size: file.size } : null,
      },
    });
    return toRecordView(record, { contentType: type.name, folder: folder.name });
  }

  async get(principal: Principal, id: string): Promise<RecordDetailView> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.requireVisible(principal, id);
    const scope = await this.access.scopeFor(principal);
    const type = await this.contentTypes.require(
      principal.tenantId,
      record.contentTypeId.toHexString(),
    );
    const folder =
      scope.levelOfFolderId(record.folderId) === null
        ? null
        : await this.foldersRepository.findById(principal.tenantId, record.folderId.toHexString());
    const access = scope.levelOfRecord(record);
    return {
      record: toRecordView(record, {
        contentType: type.name,
        folder: folder?.name ?? null,
        folderHidden: scope.levelOfFolderId(record.folderId) === null,
      }),
      contentType: toContentTypeView(type),
      breadcrumbs: folder ? await this.folders.breadcrumbs(principal.tenantId, folder, scope) : [],
      ...(access === null ? {} : { access }),
      folderAccess: scope.levelOfFolderId(record.folderId),
    };
  }

  requireVisible(
    principal: Principal,
    id: string,
    min: AccessLevel = 'view',
  ): Promise<RecordDocument> {
    return this.access.requireRecord(principal, id, min);
  }

  async list(
    principal: Principal,
    query: ListRecordsQuery,
    metadataFilters: Record<string, string>,
  ): Promise<Page<RecordView>> {
    await this.policy.authorize(principal, 'records.read');
    const search = await this.searchFilter(principal, query, metadataFilters);
    if (!search) return toPage([], 0, query);
    const { items, total } = await this.timed(() =>
      this.records.page(
        principal.tenantId,
        search.filter,
        this.sortOf(query),
        skipOf(query),
        query.pageSize,
        this.timeLimit(search),
      ),
    );
    return toPage(
      await this.withNames(principal.tenantId, items, await this.access.scopeFor(principal)),
      total,
      query,
    );
  }

  async exportCsv(
    principal: Principal,
    query: ListRecordsQuery,
    metadataFilters: Record<string, string>,
  ): Promise<{ csv: string; count: number; truncated: boolean }> {
    await this.policy.authorize(principal, 'records.read');
    const tenantId = principal.tenantId;
    const search = await this.searchFilter(principal, query, metadataFilters);
    const records = search
      ? await this.timed(() =>
          this.records.find(tenantId, search.filter, {
            sort: this.sortOf(query),
            limit: EXPORT_LIMIT + 1,
            ...this.timeLimit(search),
          }),
        )
      : [];
    const truncated = records.length > EXPORT_LIMIT;
    const rows = await this.withNames(
      tenantId,
      records.slice(0, EXPORT_LIMIT),
      await this.access.scopeFor(principal),
    );
    const fields = search?.type?.fields ?? [];
    const header = [
      'Name',
      'Content type',
      'Folder',
      'Version',
      'Tags',
      'File name',
      'File size',
      'Created',
      'Created by',
      'Updated',
      'Updated by',
      'Checked out by',
      ...(fields.length > 0
        ? fields.map((f) => (f.type === 'currency' ? `${f.label} (${f.currency})` : f.label))
        : ['Metadata']),
    ];
    const userNames = await this.userNames(tenantId, fields, rows);
    const cell = (field: FieldDefinition, value: unknown): unknown => {
      if (field.type === 'user' && typeof value === 'string') return userNames.get(value) ?? value;
      return Array.isArray(value) ? value.join('; ') : value;
    };
    const lines = [csvRow(header)];
    for (const row of rows) {
      lines.push(
        csvRow([
          row.name,
          row.contentTypeName,
          row.folderName,
          row.currentVersion,
          row.tags.join('; '),
          row.file?.fileName,
          row.file?.size,
          row.createdAt,
          row.createdBy.displayName,
          row.updatedAt,
          row.updatedBy.displayName,
          row.checkedOut?.displayName,
          ...(fields.length > 0 ? fields.map((f) => cell(f, row.metadata[f.key])) : [row.metadata]),
        ]),
      );
    }
    await this.audit.record(tenantId, {
      action: 'RECORDS_EXPORTED',
      actor: actorOf(principal),
      resource: { type: 'search' },
      context: {
        count: rows.length,
        truncated,
        filters: {
          q: query.q,
          contentTypeId: query.contentTypeId,
          folderId: query.folderId,
          tags: query.tag,
          metadata: metadataFilters,
        },
      },
    });
    return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, count: rows.length, truncated };
  }

  private sortOf(query: ListRecordsQuery): Record<string, SortOrder> {
    const direction: SortOrder = query.order === 'asc' ? 1 : -1;
    return { [query.sort]: direction, _id: direction };
  }

  private timeLimit(search: SearchFilter): { maxTimeMS?: number } {
    return search.textual ? { maxTimeMS: this.config.SEARCH_MAX_TIME_MS } : {};
  }

  private async timed<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isMaxTimeExpired(error)) throw errors.searchTimeout();
      throw error;
    }
  }

  private async searchFilter(
    principal: Principal,
    query: ListRecordsQuery,
    metadataFilters: Record<string, string>,
  ): Promise<SearchFilter | null> {
    const tenantId = principal.tenantId;
    const visible = await this.access.recordScope(principal, 'view');
    const filter: QueryFilter<RecordEntity> = { deletedAt: null };
    const conditions: QueryFilter<RecordEntity>[] = [];
    let textual = false;
    let type: ContentTypeDocument | null = null;
    const text = query.q ? searchCondition(query.q) : null;
    if (text) {
      conditions.push(text);
      textual = true;
    }
    if (query.tag.length > 0) filter.tags = { $all: query.tag };
    if (query.contentTypeId) {
      type = isObjectId(query.contentTypeId)
        ? await this.contentTypesRepository.findById(tenantId, query.contentTypeId)
        : null;
      if (!type) return null;
      filter.contentTypeId = type._id;
    }
    if (query.folderId) {
      const folder = await this.access.requireFolder(principal, query.folderId, 'view');
      filter.folderId = query.includeSubfolders
        ? { $in: await this.folders.liveSubtreeIds(tenantId, folder.id as string) }
        : folder._id;
    }
    if (query.from || query.to) {
      filter[query.dateField] = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    for (const [key, raw] of Object.entries(metadataFilters)) {
      if (!META_KEY.test(key)) {
        throw errors.badRequest('INVALID_FILTER', `Invalid metadata field name "${key}"`);
      }
      const { clause, folded } = metadataCondition(
        key,
        type?.fields.find((f) => f.key === key),
        raw,
      );
      if (!clause) continue;
      conditions.push(clause);
      textual ||= folded;
    }
    return {
      filter: { $and: [visible, filter, ...conditions] } as QueryFilter<RecordEntity>,
      type,
      textual,
    };
  }

  async rename(principal: Principal, id: string, input: RenameRecordInput): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', id });
    const { before, after } = await this.state.rename(principal, id, input.name);
    await this.audit.record(principal.tenantId, {
      action: 'RECORD_UPDATED',
      actor: actorOf(principal),
      resource: { type: 'record', id, label: after.name },
      context: { previousName: before.name },
    });
    return this.viewOf(principal, after);
  }

  async move(principal: Principal, id: string, input: MoveRecordInput): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', id });
    const tenantId = principal.tenantId;
    const scope = await this.access.scopeFor(principal);
    const record = await this.requireVisible(principal, id);
    const target = await this.access.requireFolder(principal, input.folderId, 'view', {
      what: 'Target folder',
    });
    const resource = { type: 'record', id, label: record.name };
    const fromFolder = scope.levelOfFolderId(record.folderId);
    await this.access.assertLevel(
      principal,
      resource,
      atLeast(fromFolder, 'edit') ? 'edit' : 'view',
      'edit',
    );
    await this.access.assertLevel(
      principal,
      { type: 'folder', id: target.id as string, label: target.name },
      scope.levelOfFolder(target),
      'edit',
      'Target folder',
    );
    const updated = await this.records.updateOne(
      tenantId,
      {
        _id: record._id,
        deletedAt: null,
        ...(scope.unrestricted ? {} : { folderId: record.folderId }),
      },
      { folderId: target._id },
    );
    if (!updated) throw errors.notFound('Record');
    const [targetNow, fresh] = await Promise.all([
      this.foldersRepository.findById(tenantId, target.id as string),
      this.access.scopeFor(principal, { fresh: true }),
    ]);
    if (!targetNow || targetNow.deletedAt || !atLeast(fresh.levelOfFolder(targetNow), 'edit')) {
      const movedBack = await this.records.updateOne(
        tenantId,
        { _id: record._id, deletedAt: null, folderId: target._id },
        { folderId: record.folderId },
      );
      if (movedBack) await this.leaveTrashedSource(principal, record);
      throw errors.notFound('Target folder');
    }
    await this.audit.record(tenantId, {
      action: 'RECORD_MOVED',
      actor: actorOf(principal),
      resource,
      context: { fromFolderId: record.folderId.toHexString(), toFolderId: target.id as string },
    });
    return this.viewOf(principal, updated);
  }

  async setTags(principal: Principal, id: string, input: SetTagsInput): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', id });
    return this.retagged(principal, await this.state.retag(principal, id, { set: input.tags }));
  }

  async changeTags(
    principal: Principal,
    id: string,
    change: { add: string[]; remove: string[] },
  ): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', id });
    return this.retagged(principal, await this.state.retag(principal, id, change));
  }

  private async retagged(principal: Principal, transition: RecordTransition): Promise<RecordView> {
    const { before, after, changed } = transition;
    if (changed) {
      await this.audit.record(principal.tenantId, {
        action: 'RECORD_TAGS_CHANGED',
        actor: actorOf(principal),
        resource: { type: 'record', id: before.id, label: before.name },
        context: {
          added: after.tags.filter((tag) => !before.tags.includes(tag)),
          removed: before.tags.filter((tag) => !after.tags.includes(tag)),
        },
      });
    }
    return this.viewOf(principal, after);
  }

  async tagCloud(principal: Principal): Promise<Array<{ tag: string; count: number }>> {
    await this.policy.authorize(principal, 'records.read');
    const visible = await this.access.recordScope(principal, 'view');
    return this.records.tagCounts(principal.tenantId, visible);
  }

  async listVersions(principal: Principal, id: string): Promise<VersionView[]> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.requireVisible(principal, id);
    const versions = await this.versions.find(
      principal.tenantId,
      { recordId: record._id },
      { sort: { versionNumber: -1 } },
    );
    return versions.map((version) => toVersionView(version, record.currentVersion));
  }

  async getVersion(principal: Principal, id: string, versionNumber: number): Promise<VersionView> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.requireVisible(principal, id);
    return toVersionView(await this.requireVersion(record, versionNumber), record.currentVersion);
  }

  async openFile(
    principal: Principal,
    id: string,
    versionNumber: number | 'current',
  ): Promise<OpenedFile> {
    await this.policy.authorize(principal, 'records.read');
    const record = await this.requireVisible(principal, id);
    const file =
      versionNumber === 'current'
        ? record.file
        : (await this.requireVersion(record, versionNumber)).file;
    if (!file) throw errors.notFound('File');
    return {
      stream: await this.blobs.open(principal.tenantId, file),
      file: {
        sha256: file.sha256,
        size: file.size,
        mimeType: file.mimeType,
        fileName: file.fileName,
      },
    };
  }

  async addVersion(
    principal: Principal,
    id: string,
    input: NewVersionInput,
    upload: UploadedFile | null,
  ): Promise<VersionView> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', id });
    const tenantId = principal.tenantId;
    const record = await this.state.requireWritable(principal, id);
    if (!upload && input.metadata === undefined) {
      throw errors.badRequest(
        'NOTHING_TO_VERSION',
        'Upload a file or change the metadata to create a version',
      );
    }
    const type = await this.contentTypes.require(tenantId, record.contentTypeId.toHexString());
    const metadataChanged = input.metadata !== undefined;
    const metadata = metadataChanged
      ? validateMetadata(type.fields, input.metadata ?? {})
      : record.metadata;
    if (metadataChanged) {
      await this.assertUsersActive(tenantId, type.fields, metadata, record.metadata);
    }
    const file = upload ? await this.blobs.ingest(tenantId, upload) : record.file;
    const { current, version } = await this.sweepingOnFailure(
      tenantId,
      upload ? file : null,
      async () => {
        const live = upload
          ? await this.state.requireWritable(principal, id, { fresh: true })
          : record;
        const appended = await this.state.commitVersion(principal, live, type, {
          file,
          metadata,
          schemaVersion: metadataChanged ? type.schemaVersion : record.schemaVersion,
          comment: input.comment,
          restoredFrom: null,
        });
        return { current: live, version: appended };
      },
    );
    await this.audit.record(tenantId, {
      action: 'VERSION_CREATED',
      actor: actorOf(principal),
      resource: { type: 'record', id, label: current.name },
      context: {
        version: version.versionNumber,
        newFile: upload ? { name: file?.fileName, size: file?.size } : null,
        metadataChanged,
        comment: input.comment,
      },
    });
    await this.events.emit({
      type: 'version.created',
      tenantId,
      actor: actorOf(principal),
      record: { id, name: current.name },
      versionNumber: version.versionNumber,
    });
    return toVersionView(version, version.versionNumber);
  }

  async restoreVersion(
    principal: Principal,
    id: string,
    versionNumber: number,
    input: RestoreVersionInput,
  ): Promise<VersionView> {
    await this.policy.authorize(principal, 'records.write', { type: 'record', id });
    const tenantId = principal.tenantId;
    const record = await this.state.requireWritable(principal, id);
    const source = await this.requireVersion(record, versionNumber);
    const type = await this.contentTypes.require(tenantId, record.contentTypeId.toHexString());
    const version = await this.state.commitVersion(principal, record, type, {
      file: source.file,
      metadata: source.metadata,
      schemaVersion: source.schemaVersion,
      comment: input.comment || `Restored from version ${versionNumber}`,
      restoredFrom: versionNumber,
    });
    await this.audit.record(tenantId, {
      action: 'VERSION_RESTORED',
      actor: actorOf(principal),
      resource: { type: 'record', id, label: record.name },
      context: { restoredFrom: versionNumber, newVersion: version.versionNumber },
    });
    await this.events.emit({
      type: 'version.created',
      tenantId,
      actor: actorOf(principal),
      record: { id, name: record.name },
      versionNumber: version.versionNumber,
    });
    return toVersionView(version, version.versionNumber);
  }

  async checkOut(principal: Principal, id: string): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.checkout', { type: 'record', id });
    const { before, after, changed } = await this.state.checkOut(principal, id);
    if (changed) {
      await this.audit.record(principal.tenantId, {
        action: 'RECORD_CHECKED_OUT',
        actor: actorOf(principal),
        resource: { type: 'record', id, label: before.name },
      });
    }
    return this.viewOf(principal, after);
  }

  async checkIn(principal: Principal, id: string): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.checkout', { type: 'record', id });
    const transition = await this.state.release(principal, id, 'checkIn');
    return this.released(principal, transition, 'RECORD_CHECKED_IN');
  }

  async forceRelease(principal: Principal, id: string): Promise<RecordView> {
    await this.policy.authorize(principal, 'records.forceRelease', { type: 'record', id });
    const transition = await this.state.release(principal, id, 'force');
    return this.released(principal, transition, 'RECORD_FORCE_RELEASED');
  }

  requireLive(tenantId: string, id: string): Promise<RecordDocument> {
    return this.state.requireLive(tenantId, id);
  }

  private async leaveTrashedSource(principal: Principal, record: RecordDocument): Promise<void> {
    const tenantId = principal.tenantId;
    const sourceId = record.folderId;
    const source = await this.foldersRepository.findById(tenantId, sourceId.toHexString());
    if (source && !source.deletedAt) return;
    const root = await this.folders.ensureRoot(principal);
    const moved = await this.records.updateOne(
      tenantId,
      { _id: record._id, deletedAt: null, folderId: sourceId },
      { folderId: root._id },
    );
    if (!moved) return;
    await this.audit.record(tenantId, {
      action: 'RECORD_MOVED',
      actor: actorOf(principal),
      resource: { type: 'record', id: record.id, label: record.name },
      context: {
        fromFolderId: sourceId.toHexString(),
        toFolderId: root.id,
        movedToRoot: true,
      },
    });
  }

  private async assertUsersActive(
    tenantId: string,
    fields: FieldDefinition[],
    metadata: Record<string, unknown>,
    previous: Record<string, unknown> = {},
  ): Promise<void> {
    const picked = fields
      .filter(
        (f) =>
          f.type === 'user' &&
          typeof metadata[f.key] === 'string' &&
          metadata[f.key] !== previous[f.key],
      )
      .map((f) => ({ key: f.key, id: metadata[f.key] as string }));
    if (picked.length === 0) return;
    const ids = [...new Set(picked.map((p) => p.id))];
    const active = await this.users.find(tenantId, {
      _id: { $in: ids.map(toObjectId) },
      status: 'active',
    });
    const known = new Set(active.map((user) => user.id as string));
    const unknown = picked.filter((p) => !known.has(p.id));
    if (unknown.length > 0) {
      throw errors.validation(
        unknown.map((p) => ({
          path: `metadata.${p.key}`,
          message: 'Not an active user of this tenant',
        })),
      );
    }
  }

  private async userNames(
    tenantId: string,
    fields: FieldDefinition[],
    rows: RecordView[],
  ): Promise<Map<string, string>> {
    const keys = fields.filter((f) => f.type === 'user').map((f) => f.key);
    const ids = new Set(
      rows.flatMap((row) =>
        keys.map((k) => row.metadata[k]).filter((v): v is string => typeof v === 'string'),
      ),
    );
    if (ids.size === 0) return new Map();
    const users = await this.users.find(tenantId, { _id: { $in: [...ids].map(toObjectId) } });
    return new Map(users.map((user) => [user.id as string, user.displayName]));
  }

  async viewOf(principal: Principal, record: RecordDocument): Promise<RecordView> {
    const scope = await this.access.scopeFor(principal);
    return (await this.withNames(principal.tenantId, [record], scope))[0];
  }

  async withNames(
    tenantId: string,
    records: RecordDocument[],
    scope: AccessScope,
  ): Promise<RecordView[]> {
    const typeIds = [...new Set(records.map((r) => r.contentTypeId.toHexString()))].map(toObjectId);
    const folderIds = [
      ...new Set(
        records
          .filter((r) => scope.levelOfFolderId(r.folderId) !== null)
          .map((r) => r.folderId.toHexString()),
      ),
    ].map(toObjectId);
    const [types, folders] = await Promise.all([
      typeIds.length ? this.contentTypesRepository.find(tenantId, { _id: { $in: typeIds } }) : [],
      folderIds.length ? this.foldersRepository.find(tenantId, { _id: { $in: folderIds } }) : [],
    ]);
    const typeNames = new Map(types.map((t) => [t.id, t.name]));
    const folderNames = new Map(folders.map((f) => [f.id, f.name]));
    return records.map((record) =>
      toRecordView(record, {
        contentType: typeNames.get(record.contentTypeId.toHexString()) ?? null,
        folder: folderNames.get(record.folderId.toHexString()) ?? null,
        folderHidden: scope.levelOfFolderId(record.folderId) === null,
      }),
    );
  }

  private async released(
    principal: Principal,
    { before: record, after }: RecordTransition,
    action: 'RECORD_CHECKED_IN' | 'RECORD_FORCE_RELEASED',
  ): Promise<RecordView> {
    await this.audit.record(principal.tenantId, {
      action,
      actor: actorOf(principal),
      resource: { type: 'record', id: record.id, label: record.name },
      context: { heldBy: record.checkedOutByName },
    });
    if (action === 'RECORD_FORCE_RELEASED' && record.checkedOutBy) {
      await this.events.emit({
        type: 'checkout.forceReleased',
        tenantId: principal.tenantId,
        actor: actorOf(principal),
        record: { id: record.id, name: record.name },
        holderId: record.checkedOutBy.toHexString(),
      });
    }
    return this.viewOf(principal, after);
  }

  private async sweepingOnFailure<T>(
    tenantId: string,
    stored: FileRef | null,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (stored) await this.blobs.sweepUnreferenced(tenantId);
      throw error;
    }
  }

  private async requireVersion(
    record: RecordDocument,
    versionNumber: number,
  ): Promise<RecordVersionDocument> {
    const version = await this.versions.byNumber(
      record.tenantId.toHexString(),
      record._id,
      versionNumber,
    );
    if (!version) throw errors.notFound('Version');
    return version;
  }
}
