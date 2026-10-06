import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldDefinition } from '../content-types/field-types.js';
import {
  contentKeyUpdate,
  foldedMetaCondition,
  indexedFields,
  metaKeysOf,
  searchCondition,
  staleKeysFilter,
  textKeyUpdate,
  versionKeyUpdate,
} from './search-keys.js';

const fields: FieldDefinition[] = [
  { key: 'supplier', label: 'Supplier', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: false },
  { key: 'paid', label: 'Paid', type: 'boolean', required: false },
];

function regexesOf(value: unknown): Array<{ pattern: unknown; options: unknown }> {
  if (Array.isArray(value)) return value.flatMap(regexesOf);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const own =
    '$regex' in record ? [{ pattern: record['$regex'], options: record['$options'] }] : [];
  return [...own, ...Object.values(record).flatMap(regexesOf)];
}

describe('search keys', () => {
  it('builds the nested insert keys and the dotted update keys from the same data', () => {
    const metadata = { supplier: 'مؤسسة أحمد', amount: 12, paid: true };
    const inserted = indexedFields('فاتورة ١٢٣', fields, metadata, 'Scan.PDF', ['q3']);
    expect(inserted.searchText).toBe('فاتورة ١٢٣ مؤسسة أحمد 12 scan.pdf q3');
    expect(inserted.search).toEqual({
      text: 'فاتوره 123 موسسه احمد 12 scan.pdf q3',
      v: 1,
      meta: { supplier: 'موسسه احمد' },
      mv: 1,
    });
    const dotted = versionKeyUpdate(inserted.searchText, metadata);
    expect(dotted).toEqual({
      'search.text': inserted.search.text,
      'search.v': inserted.search.v,
      'search.meta': inserted.search.meta,
      'search.mv': inserted.search.mv,
    });
    expect(textKeyUpdate(inserted.searchText)).toEqual({
      'search.text': inserted.search.text,
      'search.v': 1,
    });
  });

  it('keeps only own string metadata values whose names are safe field keys', () => {
    const inherited = Object.create({ inheritedKey: 'x' }) as Record<string, unknown>;
    inherited['own'] = 'أحمد';
    expect(metaKeysOf(inherited)).toEqual({ own: 'احمد' });
    expect(
      metaKeysOf({
        text: 'Globex',
        count: 3,
        list: ['a'],
        none: null,
        'bad.key': 'x',
        $where: 'x',
        _id: 'x',
      }),
    ).toEqual({ text: 'globex' });
    const parsed = JSON.parse('{"__proto__": "x", "ok": "y"}') as Record<string, unknown>;
    const keys = metaKeysOf(parsed);
    expect(keys).toEqual({ ok: 'y' });
    expect(Object.getPrototypeOf(keys)).toBe(Object.prototype);
  });

  it('keys file text, with null for none', () => {
    expect(contentKeyUpdate('فاتورة')).toEqual({ 'search.content': 'فاتوره', 'search.cv': 1 });
    expect(contentKeyUpdate(null)).toEqual({ 'search.content': null, 'search.cv': 1 });
  });

  it('matches the stored key, or before the backfill the lowercase searchText', () => {
    expect(searchCondition('أحمد')).toEqual({
      $or: [
        { 'search.text': { $regex: 'احمد' } },
        { 'search.v': { $not: { $gte: 1 } }, searchText: { $regex: 'أحمد' } },
      ],
    });
    expect(searchCondition('Q3.PDF')).toEqual({
      $or: [
        { 'search.text': { $regex: 'q3\\.pdf' } },
        { 'search.v': { $not: { $gte: 1 } }, searchText: { $regex: 'q3\\.pdf' } },
      ],
    });
  });

  it('adds no condition for a query that folds to nothing', () => {
    expect(searchCondition('\u0640\u0640\u0640')).toBeNull();
    expect(searchCondition('\u200F \u064E')).toBeNull();
    expect(foldedMetaCondition('supplier', '\u0640')).toBeNull();
  });

  it('never lets a control character or an unescaped metacharacter reach a pattern', () => {
    for (const q of ['a\u0000b', '\u200Fa.*b\u200E', '(', '[', 'a+b', '\\', '$^|{}?']) {
      const condition = searchCondition(q);
      for (const { pattern } of regexesOf(condition)) {
        expect(typeof pattern).toBe('string');
        const text = pattern as string;
        for (const char of text) expect(char.charCodeAt(0) >= 0x20).toBe(true);
        const unescaped = text.replace(/\\[.*+?^${}()|[\]\\]/g, '');
        expect(unescaped).not.toMatch(/[.*+?^${}()|[\]\\]/);
      }
    }
  });

  it('only ever uses no flags or the case-insensitive flag', () => {
    const conditions = [
      searchCondition('Globex أحمد'),
      foldedMetaCondition('supplier', 'Glob أحمد'),
      staleKeysFilter(),
    ];
    const options = conditions.flatMap(regexesOf).map((r) => r.options);
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect([undefined, 'i']).toContain(option);
  });

  it('folds a meta filter, keeping the case-insensitive raw match for records not backfilled', () => {
    expect(foldedMetaCondition('supplier', 'مدرسة')).toEqual({
      $or: [
        { 'search.meta.supplier': { $regex: 'مدرسه' } },
        {
          'search.mv': { $not: { $gte: 1 } },
          'metadata.supplier': { $regex: 'مدرسة', $options: 'i' },
        },
      ],
    });
  });

  it('selects records with a stale text or metadata key for the backfill', () => {
    expect(staleKeysFilter()).toEqual({
      $or: [{ 'search.v': { $not: { $gte: 1 } } }, { 'search.mv': { $not: { $gte: 1 } } }],
    });
  });
});

describe('search key write sites', () => {
  const srcDir = fileURLToPath(new URL('..', import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
    });
  }

  function callSites(name: string): Record<string, number> {
    const pattern = new RegExp(`(?<!function )\\b${name}\\(`, 'g');
    const sites: Record<string, number> = {};
    for (const path of sourceFiles(srcDir)) {
      const count = readFileSync(path, 'utf8').match(pattern)?.length ?? 0;
      if (count > 0) sites[relative(srcDir, path).split('\\').join('/')] = count;
    }
    return sites;
  }

  it('computes searchText only where a search-key helper is spread next to it', () => {
    expect(callSites('searchTextOf')).toEqual({
      'records/record-state.ts': 3,
      'records/search-keys.ts': 1,
    });
    expect(callSites('indexedFields')).toEqual({ 'records/records.service.ts': 1 });
    expect(callSites('textKeyUpdate')).toEqual({
      'records/record-state.ts': 2,
      'records/search-backfill.ts': 1,
      'records/search-keys.ts': 1,
    });
    expect(callSites('versionKeyUpdate')).toEqual({ 'records/record-state.ts': 1 });
  });
});
