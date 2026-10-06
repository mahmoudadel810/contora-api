import type { QueryFilter } from 'mongoose';
import { SEARCH_KEY_VERSION, searchKey, stripInvisibles } from '../common/arabic-normalize.js';
import type { FieldDefinition } from '../content-types/field-types.js';
import { escapeRegex, searchTextOf } from './metadata.js';
import type { RecordEntity } from './record.schema.js';

export const META_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

export function staleMarker(): { $not: { $gte: number } } {
  return { $not: { $gte: SEARCH_KEY_VERSION } };
}

export interface IndexedSearchKeys {
  text: string;
  v: number;
  meta: Record<string, string>;
  mv: number;
}

export function metaKeysOf(metadata: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter((entry): entry is [string, string] => {
        return META_KEY.test(entry[0]) && typeof entry[1] === 'string';
      })
      .map(([key, value]) => [key, searchKey(value)]),
  );
}

export function indexedFields(
  name: string,
  fields: FieldDefinition[],
  metadata: Record<string, unknown>,
  fileName: string | null,
  tags: string[],
): { searchText: string; search: IndexedSearchKeys } {
  const searchText = searchTextOf(name, fields, metadata, fileName, tags);
  return {
    searchText,
    search: {
      text: searchKey(searchText),
      v: SEARCH_KEY_VERSION,
      meta: metaKeysOf(metadata),
      mv: SEARCH_KEY_VERSION,
    },
  };
}

export function textKeyUpdate(searchText: string): { 'search.text': string; 'search.v': number } {
  return { 'search.text': searchKey(searchText), 'search.v': SEARCH_KEY_VERSION };
}

export function versionKeyUpdate(
  searchText: string,
  metadata: Record<string, unknown>,
): {
  'search.text': string;
  'search.v': number;
  'search.meta': Record<string, string>;
  'search.mv': number;
} {
  return {
    ...textKeyUpdate(searchText),
    'search.meta': metaKeysOf(metadata),
    'search.mv': SEARCH_KEY_VERSION,
  };
}

export function contentKeyUpdate(contentText: string | null): {
  'search.content': string | null;
  'search.cv': number;
} {
  return {
    'search.content': contentText === null ? null : searchKey(contentText),
    'search.cv': SEARCH_KEY_VERSION,
  };
}

export function searchCondition(q: string): QueryFilter<RecordEntity> | null {
  const key = searchKey(q);
  if (key === '') return null;
  return {
    $or: [
      { 'search.text': { $regex: escapeRegex(key) } },
      {
        'search.v': staleMarker(),
        searchText: { $regex: escapeRegex(stripInvisibles(q).toLowerCase()) },
      },
    ],
  } as QueryFilter<RecordEntity>;
}

export function foldedMetaCondition(key: string, raw: string): QueryFilter<RecordEntity> | null {
  const folded = searchKey(raw);
  if (folded === '') return null;
  return {
    $or: [
      { [`search.meta.${key}`]: { $regex: escapeRegex(folded) } },
      {
        'search.mv': staleMarker(),
        [`metadata.${key}`]: { $regex: escapeRegex(stripInvisibles(raw)), $options: 'i' },
      },
    ],
  } as QueryFilter<RecordEntity>;
}

export function staleKeysFilter(): QueryFilter<RecordEntity> {
  return {
    $or: [{ 'search.v': staleMarker() }, { 'search.mv': staleMarker() }],
  } as QueryFilter<RecordEntity>;
}

export function isStale(marker: unknown): boolean {
  return !(typeof marker === 'number' && marker >= SEARCH_KEY_VERSION);
}
