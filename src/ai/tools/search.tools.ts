import { z } from 'zod';
import { errors } from '../../common/errors.js';
import { issuesOf } from '../../common/zod.pipe.js';
import type { RecordView } from '../../records/record.view.js';
import {
  ListRecordsQuerySchema,
  META_PREFIX,
  metadataFiltersOf,
} from '../../records/records.dto.js';
import type { SearchCriteria } from '../../saved-searches/saved-searches.dto.js';
import { notice, recordCardOf, type BlockDraft } from '../blocks.js';
import { savedSearchLink, searchLink } from '../links.js';
import { defineTool, type ToolContext, type ToolDef } from './tool.js';

export const MODEL_ROWS = 20;

export const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Expected a 24-hex id');

export function recordRow(record: RecordView) {
  return {
    id: record.id,
    name: record.name,
    contentType: record.contentTypeName,
    folder: record.folderName,
    tags: record.tags,
    updatedAt: record.updatedAt,
    fileName: record.file?.fileName ?? null,
  };
}

export function cardFoldersOf(records: RecordView[]): Record<string, string> {
  return Object.fromEntries(
    records.flatMap((record) => (record.folderId ? [[record.id, record.folderId]] : [])),
  );
}

export function recordsBlock(
  title: string,
  records: RecordView[],
  total: number,
  link: string | null,
  titleFolderId?: string,
): BlockDraft {
  return {
    kind: 'records',
    title,
    total,
    truncated: total > records.length,
    items: records.map(recordCardOf),
    link,
    scope: {
      domain: 'records',
      cardFolders: cardFoldersOf(records),
      ...(titleFolderId ? { folderId: titleFolderId } : {}),
    },
  };
}

interface SearchPage {
  items: RecordView[];
  total: number;
}

async function searchRecords(
  ctx: ToolContext,
  query: Record<string, unknown>,
): Promise<SearchPage> {
  const parsed = ListRecordsQuerySchema.safeParse({ ...query, pageSize: String(MODEL_ROWS) });
  if (!parsed.success) throw errors.validation(issuesOf(parsed.error));
  return ctx.services.records.list(ctx.principal, parsed.data, metadataFiltersOf(query));
}

function resultOf(title: string, page: SearchPage, link: string | null, pageNumber = 1) {
  const blocks: BlockDraft[] =
    page.items.length === 0
      ? [notice('Nothing matched this search.')]
      : [recordsBlock(title, page.items, page.total, link)];
  return {
    data: {
      total: page.total,
      page: pageNumber,
      truncated: page.total > pageNumber * MODEL_ROWS,
      items: page.items.slice(0, MODEL_ROWS).map(recordRow),
    },
    blocks,
  };
}

const SearchRecordsInput = z
  .object({
    q: z.string().max(200).nullable().describe('Text to find in names, metadata, file names, tags'),
    contentTypeId: objectId.nullable(),
    folderId: objectId.nullable(),
    includeSubfolders: z.boolean().nullable(),
    tags: z.array(z.string().max(40)).max(20).nullable().describe('Records must have every tag'),
    dateField: z.enum(['createdAt', 'updatedAt']).nullable(),
    from: z.string().max(40).nullable().describe('ISO date, inclusive'),
    to: z.string().max(40).nullable().describe('ISO date, inclusive'),
    meta: z
      .array(z.object({ key: z.string().max(40), value: z.string().max(200) }).strict())
      .max(10)
      .nullable()
      .describe('Metadata filters by field key (see the schema summary)'),
    sort: z.enum(['name', 'createdAt', 'updatedAt']).nullable(),
    order: z.enum(['asc', 'desc']).nullable(),
    page: z.number().int().min(1).max(50).nullable(),
  })
  .strict();

const searchSearchRecords = defineTool({
  name: 'search_search_records',
  domain: 'search',
  description:
    'Search the records the user can see by text, content type, folder, tags, date range and metadata values. Returns at most 20 rows per page with the total.',
  input: SearchRecordsInput,
  async run(ctx, input) {
    const query: Record<string, unknown> = {};
    if (input.q) query.q = input.q;
    if (input.contentTypeId) query.contentTypeId = input.contentTypeId;
    if (input.folderId) query.folderId = input.folderId;
    if (input.includeSubfolders !== null) query.includeSubfolders = String(input.includeSubfolders);
    if (input.tags && input.tags.length > 0) query.tag = input.tags.join(',');
    if (input.dateField) query.dateField = input.dateField;
    if (input.from) query.from = input.from;
    if (input.to) query.to = input.to;
    if (input.sort) query.sort = input.sort;
    if (input.order) query.order = input.order;
    if (input.page) query.page = String(input.page);
    for (const { key, value } of input.meta ?? []) query[`${META_PREFIX}${key}`] = value;
    const page = await searchRecords(ctx, query);
    const onlyTextAndTags =
      !input.contentTypeId &&
      !input.folderId &&
      !input.dateField &&
      !input.from &&
      !input.to &&
      (input.meta ?? []).length === 0;
    const link = onlyTextAndTags ? searchLink({ q: input.q, tags: input.tags ?? [] }) : null;
    return resultOf('Search results', page, link, input.page ?? 1);
  },
});

const searchListTags = defineTool({
  name: 'search_list_tags',
  domain: 'search',
  description: 'The tags in use on records, with how many records carry each.',
  input: z.object({}).strict(),
  async run(ctx) {
    const tags = await ctx.services.records.tagCloud(ctx.principal);
    const top = [...tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    const shown = top.slice(0, 50);
    return {
      data: {
        total: tags.length,
        truncated: tags.length > MODEL_ROWS,
        items: top.slice(0, MODEL_ROWS),
      },
      blocks:
        tags.length === 0
          ? [notice('No record has a tag yet.')]
          : [
              {
                kind: 'table',
                title: 'Tags',
                columns: ['Tag', 'Records'],
                rows: shown.map(({ tag, count }) => [tag, String(count)]),
                truncated: tags.length > shown.length,
                scope: { domain: 'search', derived: true },
              },
            ],
    };
  },
});

const searchListSaved = defineTool({
  name: 'search_list_saved',
  domain: 'search',
  description: "The user's own saved searches (names and ids).",
  input: z.object({}).strict(),
  async run(ctx) {
    const searches = await ctx.services.savedSearches.list(ctx.principal);
    return {
      data: {
        total: searches.length,
        truncated: searches.length > MODEL_ROWS,
        items: searches.slice(0, MODEL_ROWS).map(({ id, name }) => ({ id, name })),
      },
      blocks:
        searches.length === 0
          ? [notice('You have no saved searches.')]
          : [
              {
                kind: 'table',
                title: 'Saved searches',
                columns: ['Name'],
                rows: searches.map(({ name }) => [name]),
                truncated: false,
              },
            ],
    };
  },
});

function queryOfCriteria(criteria: SearchCriteria): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (criteria.q) query.q = criteria.q;
  if (criteria.contentTypeId) query.contentTypeId = criteria.contentTypeId;
  if (criteria.folder) query.folderId = criteria.folder.id;
  if (criteria.includeSubfolders !== undefined) {
    query.includeSubfolders = String(criteria.includeSubfolders);
  }
  if (criteria.dateField) query.dateField = criteria.dateField;
  if (criteria.from) query.from = criteria.from;
  if (criteria.to) query.to = criteria.to;
  if (criteria.tags && criteria.tags.length > 0) query.tag = criteria.tags.join(',');
  if (criteria.metaKey && criteria.metaValue) {
    query[`${META_PREFIX}${criteria.metaKey}`] = criteria.metaValue;
  }
  return query;
}

const searchRunSaved = defineTool({
  name: 'search_run_saved',
  domain: 'search',
  description: 'Run one of the user’s saved searches by id.',
  input: z.object({ id: objectId }).strict(),
  async run(ctx, input) {
    const searches = await ctx.services.savedSearches.list(ctx.principal);
    const search = searches.find((candidate) => candidate.id === input.id);
    if (!search) throw errors.notFound('Saved search');
    const page = await searchRecords(ctx, queryOfCriteria(search.criteria));
    const result = resultOf(search.name, page, savedSearchLink(search.id));
    return { ...result, data: { ...result.data, name: search.name } };
  },
});

const searchListMy = defineTool({
  name: 'search_list_my',
  domain: 'search',
  description: "The user's favorite records, or the records they viewed recently.",
  input: z.object({ which: z.enum(['favorites', 'recent']) }).strict(),
  async run(ctx, input) {
    const records =
      input.which === 'favorites'
        ? await ctx.services.myRecords.listFavorites(ctx.principal)
        : (await ctx.services.myRecords.listRecent(ctx.principal)).map((entry) => entry.record);
    const title = input.which === 'favorites' ? 'Favorites' : 'Recently viewed';
    const shown = records.slice(0, MODEL_ROWS);
    return {
      data: {
        total: records.length,
        truncated: records.length > shown.length,
        items: shown.map(recordRow),
      },
      blocks:
        records.length === 0
          ? [notice(input.which === 'favorites' ? 'No favorites yet.' : 'Nothing viewed yet.')]
          : [recordsBlock(title, shown, records.length, null)],
    };
  },
});

export const SEARCH_TOOLS: ToolDef[] = [
  searchSearchRecords,
  searchListTags,
  searchListSaved,
  searchRunSaved,
  searchListMy,
] as ToolDef[];
