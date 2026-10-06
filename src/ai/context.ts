import type { Principal } from '../auth/principal.js';
import type { AssistantContext } from './ai.dto.js';
import type { StoredContext } from './data/ai-message.schema.js';
import type { ToolServices } from './tools/tool.js';

export interface PromptContext {
  page: string;
  currentRecord?: { id: string; name: string; contentType: string | null };
  currentFolder?: { id: string; name: string };
  currentContentType?: { id: string; name: string };
  search?: { q: string | null; tag: string | null };
  selectedRecords?: Array<{ id: string; name: string }>;
}

export interface ResolvedContext {
  stored: StoredContext;
  prompt: PromptContext;
}

async function attempt<T>(lookup: () => Promise<T>): Promise<T | null> {
  try {
    return await lookup();
  } catch {
    return null;
  }
}

export async function resolveContext(
  services: Pick<ToolServices, 'records' | 'folders' | 'contentTypes'>,
  principal: Principal,
  context: AssistantContext,
): Promise<ResolvedContext> {
  const [record, folder, contentType, selected] = await Promise.all([
    context.recordId
      ? attempt(() => services.records.get(principal, context.recordId as string))
      : null,
    context.folderId
      ? attempt(() => services.folders.get(principal, context.folderId as string))
      : null,
    context.contentTypeId
      ? attempt(() => services.contentTypes.get(principal, context.contentTypeId as string))
      : null,
    Promise.all(
      [...new Set(context.selectedRecordIds)].map((id) =>
        attempt(() => services.records.get(principal, id)),
      ),
    ),
  ]);
  const selectedRecords = selected.flatMap((detail) =>
    detail ? [{ id: detail.record.id, name: detail.record.name }] : [],
  );
  const search =
    context.search && (context.search.q || context.search.tag)
      ? { q: context.search.q || null, tag: context.search.tag || null }
      : null;

  const prompt: PromptContext = { page: context.page };
  if (record) {
    prompt.currentRecord = {
      id: record.record.id,
      name: record.record.name,
      contentType: record.record.contentTypeName,
    };
  }
  if (folder) prompt.currentFolder = { id: folder.folder.id, name: folder.folder.name };
  if (contentType) prompt.currentContentType = { id: contentType.id, name: contentType.name };
  if (search) prompt.search = search;
  if (selectedRecords.length > 0) prompt.selectedRecords = selectedRecords;

  return {
    stored: {
      page: context.page,
      recordId: record?.record.id ?? null,
      folderId: folder?.folder.id ?? null,
      contentTypeId: contentType?.id ?? null,
      search,
      selectedRecordIds: selectedRecords.map((item) => item.id),
    },
    prompt,
  };
}

export function contextOfStored(stored: StoredContext | null): AssistantContext {
  return {
    page: (stored?.page ?? 'other') as AssistantContext['page'],
    recordId: stored?.recordId ?? null,
    folderId: stored?.folderId ?? null,
    contentTypeId: stored?.contentTypeId ?? null,
    search: stored?.search ?? null,
    selectedRecordIds: stored?.selectedRecordIds ?? [],
  };
}
