import type { RecordView } from '../records/record.view.js';
import { recordLink } from './links.js';

/**
 * UI blocks (§5.3): built by the server from service results and rendered by the UI. The model
 * can refer to a block by id but never author one. On the wire a block is a discriminated union;
 * the model-facing tool schemas stay flat.
 */
export interface RecordCard {
  id: string;
  name: string;
  contentTypeName: string | null;
  folderName: string | null;
  tags: string[];
  updatedAt: string;
  fileName: string | null;
  link: string;
}

export interface RecordsBlock {
  kind: 'records';
  id: string;
  title: string;
  total: number;
  truncated: boolean;
  items: RecordCard[];
  link: string | null;
}

export interface RecordBlock {
  kind: 'record';
  id: string;
  record: RecordCard & {
    metadata: Array<{ label: string; value: string }>;
    versions: number;
    checkedOutBy: string | null;
  };
}

export interface FileBlock {
  kind: 'file';
  id: string;
  recordId: string;
  fileName: string;
  mimeType: string;
  size: number;
  previewable: boolean;
  link: string;
}

export interface FoldersBlock {
  kind: 'folders';
  id: string;
  items: Array<{ id: string; name: string; path: string; link: string }>;
}

export interface ContentTypeBlock {
  kind: 'contentType';
  id: string;
  contentType: {
    id: string;
    name: string;
    status: string;
    fields: Array<{ key: string; label: string; type: string; required: boolean }>;
    link: string;
  };
}

export interface TableBlock {
  kind: 'table';
  id: string;
  title: string;
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

/** One line of a confirm card: what changes, from what to what (server-built, never model text). */
export interface Change {
  label: string;
  before: string | null;
  after: string | null;
}

export type ActionOrigin = 'user' | 'derived';

/** The confirm button's verb, set by the server from the proposal kind (contract §17.13). */
export const CONFIRM_LABELS = [
  'trash',
  'delete',
  'remove',
  'move',
  'create',
  'update',
  'confirm',
] as const;
export type ConfirmLabel = (typeof CONFIRM_LABELS)[number];

/**
 * The card of one pending action (§5.3, §17.1). Every flag is always present: the UI treats a
 * missing flag as set (fail closed).
 */
export interface ConfirmBlock {
  kind: 'confirm';
  id: string;
  actionId: string;
  title: string;
  summary: string;
  changes: Change[];
  destructive: boolean;
  needsFile: boolean;
  reviewEach: boolean;
  origin: ActionOrigin;
  confirmLabel: ConfirmLabel;
  expiresAt: string;
}

/**
 * A confirm card whose target the reader can no longer see (§15.4, S2 review): names, values and
 * paths are gone; the UI shows "This item is no longer available" with the action's state.
 */
export interface ReducedConfirmBlock {
  kind: 'confirm';
  id: string;
  actionId: string;
  unavailable: true;
  status: string;
  confirmLabel: ConfirmLabel;
  destructive: boolean;
  needsFile: boolean;
  reviewEach: boolean;
  origin: ActionOrigin;
}

/** The ordered actions one turn proposed (§7.1). */
export interface PlanBlock {
  kind: 'plan';
  id: string;
  planId: string;
  title: string;
  steps: Array<{ actionId: string; step: number; title: string; status: string }>;
}

export interface NoticeBlock {
  kind: 'notice';
  id: string;
  tone: 'info' | 'warning';
  text: string;
}

export type Block =
  | RecordsBlock
  | RecordBlock
  | FileBlock
  | FoldersBlock
  | ContentTypeBlock
  | TableBlock
  | ConfirmBlock
  | ReducedConfirmBlock
  | PlanBlock
  | NoticeBlock;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/**
 * Where a stored block's data came from, so `GET /ai/sessions/:id` can re-check it against the
 * reader's current access (§15.4). Never sent to the client.
 */
export interface BlockScope {
  domain: string;
  /** For blocks about one record without its id in the payload (a versions table). */
  recordId?: string;
  /** For blocks that name a folder outside their items (a title such as "Records in X"). */
  folderId?: string;
  /** Record id → folder id of the cards, so a hidden folder's name is dropped on read. */
  cardFolders?: Record<string, string>;
  /** The existing records and folders a confirm card acts on (re-checked on read). */
  targets?: { records: string[]; folders: string[] };
  /**
   * An aggregate over records that cannot be re-checked item by item (the tag cloud): shown
   * again only to readers who see everything (admins), otherwise it becomes a notice.
   */
  derived?: boolean;
}

/** A block as a tool builds it: the turn assigns the id. */
export type BlockDraft = WithoutId<Block> & { scope?: BlockScope };

/** A block as `ai_messages.blocks` stores it. */
export type StoredBlock = Block & { scope?: BlockScope };

/** Mime types the record content route serves inline (`records.controller.ts`, INLINE_SAFE). */
const PREVIEWABLE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;

export function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE.test(mimeType);
}

export function recordCardOf(record: RecordView): RecordCard {
  return {
    id: record.id,
    name: record.name,
    contentTypeName: record.contentTypeName,
    folderName: record.folderName,
    tags: record.tags,
    updatedAt: record.updatedAt,
    fileName: record.file?.fileName ?? null,
    link: recordLink(record.id),
  };
}

export function notice(text: string, tone: 'info' | 'warning' = 'info'): BlockDraft {
  return { kind: 'notice', tone, text };
}

/** The client's copy: without the internal scope. */
export function blockView(block: StoredBlock): Block {
  const { scope: _scope, ...view } = block;
  return view as Block;
}
