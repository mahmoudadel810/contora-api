import type { AuditAction } from './audit-action.js';

export interface RedactableEntry {
  action: AuditAction;
  context: Record<string, unknown>;
  actor?: { id: string; email?: string; displayName: string } | null;
}

export interface FeedAccess {
  hideActorEmail: boolean;
  hiddenFolderIds: ReadonlySet<string>;
  hiddenRecordIds: ReadonlySet<string>;
}

export type FeedAccessResolver = (named: {
  folderIds: string[];
  recordIds: string[];
}) => Promise<FeedAccess>;

export interface RedactionOptions {
  showsSignInFailureReason?: boolean;
  feed?: { deletedCommentIds: ReadonlySet<string> };
  access?: FeedAccess;
}

const FOLDER_KEYS = [
  'folderId',
  'fromFolderId',
  'toFolderId',
  'parentId',
  'fromParentId',
  'toParentId',
] as const;

const RELATION_ACTIONS: readonly AuditAction[] = ['RELATION_ADDED', 'RELATION_REMOVED'];

function without(context: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(context).filter(([key]) => !keys.includes(key)));
}

export function namedIds(entries: readonly RedactableEntry[]): {
  folderIds: string[];
  recordIds: string[];
} {
  const folderIds = new Set<string>();
  const recordIds = new Set<string>();
  for (const { action, context } of entries) {
    for (const key of FOLDER_KEYS) {
      if (typeof context[key] === 'string') folderIds.add(context[key]);
    }
    const filters = context.filters as Record<string, unknown> | undefined;
    if (typeof filters?.folderId === 'string') folderIds.add(filters.folderId);
    if (RELATION_ACTIONS.includes(action) && typeof context.otherId === 'string') {
      recordIds.add(context.otherId);
    }
  }
  return { folderIds: [...folderIds], recordIds: [...recordIds] };
}

function redactForAccess<T extends RedactableEntry>(entry: T, access: FeedAccess): T {
  const hidden = (value: unknown) => typeof value === 'string' && access.hiddenFolderIds.has(value);
  const drop: string[] = FOLDER_KEYS.filter((key) => hidden(entry.context[key]));
  if (
    RELATION_ACTIONS.includes(entry.action) &&
    typeof entry.context.otherId === 'string' &&
    access.hiddenRecordIds.has(entry.context.otherId)
  ) {
    drop.push('otherId', 'otherName');
  }
  let context = drop.length > 0 ? without(entry.context, drop) : entry.context;
  const filters = context.filters as Record<string, unknown> | undefined;
  if (filters && hidden(filters.folderId)) {
    context = { ...context, filters: without(filters, ['folderId']) };
  }
  const actor =
    access.hideActorEmail && entry.actor
      ? { id: entry.actor.id, displayName: entry.actor.displayName }
      : entry.actor;
  if (context === entry.context && actor === entry.actor) return entry;
  return { ...entry, context, ...(entry.actor === undefined ? {} : { actor }) };
}

export function redactEntry<T extends RedactableEntry>(entry: T, options: RedactionOptions): T {
  const redacted = options.access ? redactForAccess(entry, options.access) : entry;
  return redactContent(redacted, options);
}

function redactContent<T extends RedactableEntry>(entry: T, options: RedactionOptions): T {
  if (entry.action === 'SIGN_IN_FAILED' && !options.showsSignInFailureReason) {
    return { ...entry, context: without(entry.context, ['reason']) };
  }
  if (options.feed) {
    if (entry.action === 'COMMENT_DELETED') {
      return { ...entry, context: without(entry.context, ['excerpt', 'author']) };
    }
    if (
      entry.action === 'COMMENT_ADDED' &&
      options.feed.deletedCommentIds.has(String(entry.context.commentId))
    ) {
      return { ...entry, context: without(entry.context, ['excerpt']) };
    }
  }
  return entry;
}
