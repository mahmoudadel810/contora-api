import type { AccessLevel } from '../access/access-scope.js';
import type { ContentTypeView } from '../content-types/content-type.schema.js';
import type { FolderCrumb } from '../folders/folder.schema.js';
import { toFileRefView, type FileRefView } from '../storage/blob.schema.js';
import type { RecordDocument } from './record.schema.js';
import type { RecordVersionDocument } from './record-version.schema.js';

export interface PersonRef {
  id: string;
  displayName: string;
}

export interface RecordView {
  id: string;
  name: string;
  contentTypeId: string;
  contentTypeName: string | null;
  folderId: string | null;
  folderName: string | null;
  currentVersion: number;
  schemaVersion: number;
  metadata: Record<string, unknown>;
  tags: string[];
  file: FileRefView | null;
  checkedOut: (PersonRef & { at: string }) | null;
  createdBy: PersonRef;
  updatedBy: PersonRef;
  createdAt: string;
  updatedAt: string;
}

export interface RecordDetailView {
  record: RecordView;
  contentType: ContentTypeView;
  breadcrumbs: FolderCrumb[];
  access?: AccessLevel;
  folderAccess?: AccessLevel | null;
}

export interface VersionView {
  versionNumber: number;
  comment: string;
  restoredFrom: number | null;
  schemaVersion: number;
  metadata: Record<string, unknown>;
  file: FileRefView | null;
  size: number | null;
  createdBy: PersonRef;
  createdAt: string;
  isCurrent: boolean;
}

export interface TrashedRecordView extends RecordView {
  deletedAt: string;
  deletedBy: PersonRef | null;
  trashedWithFolder: boolean;
}

export function toRecordView(
  record: RecordDocument,
  names: { contentType?: string | null; folder?: string | null; folderHidden?: boolean } = {},
): RecordView {
  const hidden = names.folderHidden === true;
  return {
    id: record._id.toHexString(),
    name: record.name,
    contentTypeId: record.contentTypeId.toHexString(),
    contentTypeName: names.contentType ?? null,
    folderId: hidden ? null : record.folderId.toHexString(),
    folderName: hidden ? null : (names.folder ?? null),
    currentVersion: record.currentVersion,
    schemaVersion: record.schemaVersion,
    metadata: record.metadata,
    tags: record.tags ?? [],
    file: toFileRefView(record.file),
    checkedOut:
      record.checkedOutBy && record.checkedOutAt
        ? {
            id: record.checkedOutBy.toHexString(),
            displayName: record.checkedOutByName ?? '',
            at: record.checkedOutAt.toISOString(),
          }
        : null,
    createdBy: { id: record.createdBy.toHexString(), displayName: record.createdByName },
    updatedBy: { id: record.updatedBy.toHexString(), displayName: record.updatedByName },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toVersionView(version: RecordVersionDocument, currentVersion: number): VersionView {
  return {
    versionNumber: version.versionNumber,
    comment: version.comment,
    restoredFrom: version.restoredFrom,
    schemaVersion: version.schemaVersion,
    metadata: version.metadata,
    file: toFileRefView(version.file),
    size: version.file ? version.file.size : null,
    createdBy: { id: version.createdBy.toHexString(), displayName: version.createdByName },
    createdAt: version.createdAt.toISOString(),
    isCurrent: version.versionNumber === currentVersion,
  };
}
