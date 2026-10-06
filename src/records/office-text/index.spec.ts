import {
  bomb,
  corrupt,
  type CorruptKind,
  dataDescriptor,
  doctype,
  duplicateNames,
  encrypted,
  fakeEocdInComment,
  largeDocx,
  mixedCaseNames,
  overlapBomb,
  protoPollution,
  storedOverlap,
  zeroBomb,
  zip64,
  zipEncrypted,
} from '../../../test/helpers/ooxml-hostile.js';
import { buildZip, docx, xlsx, xlsxParts } from '../../seed/ooxml-sample.js';
import {
  extractOfficeText,
  type OfficeNoText,
  type OfficeTextResult,
  sniffContainer,
} from './index.js';
import { officeLimits } from './limits.js';
import { extractFromArchive } from './ooxml.js';
import { readZip } from './zip-reader.js';

const MIB = 1024 * 1024;
const REASONS: readonly OfficeNoText[] = [
  'not-zip',
  'ole-container',
  'not-ooxml',
  'unsupported-zip',
  'corrupt',
  'limit',
  'empty',
];

function textOf(result: OfficeTextResult): string {
  if (!result.ok) throw new Error(`expected text, got ${result.reason}`);
  return result.text;
}

function timed<T>(work: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = work();
  return { value, ms: performance.now() - start };
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sniffContainer', () => {
  it('recognises ZIP (local header or empty-archive EOCD) and OLE/CFB by the first bytes', () => {
    expect(sniffContainer(docx({ body: ['x'] }))).toBe('zip');
    expect(sniffContainer(buildZip([]))).toBe('zip');
    expect(sniffContainer(encrypted())).toBe('ole');
    expect(sniffContainer(Buffer.from('%PDF-1.7\n'))).toBeNull();
    expect(sniffContainer(Buffer.from('PK'))).toBeNull();
    expect(sniffContainer(new Uint8Array(0))).toBeNull();
    expect(sniffContainer(encrypted().subarray(0, 7))).toBeNull();
  });

  it('sees the full CFB magic in the encrypted() fixture', () => {
    expect([...encrypted().subarray(0, 8)]).toEqual([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
  });
});

describe('extractOfficeText', () => {
  it('extracts a DOCX regardless of how the client named it (AC 10)', () => {
    const result = extractOfficeText(docx({ body: ['octet stream phrase'] }));
    expect(result).toEqual({
      ok: true,
      format: 'docx',
      text: 'octet stream phrase\n',
      truncated: false,
    });
  });

  it('gives text for a DOCX under 4 KiB, also from a view with a byte offset', () => {
    const bytes = docx({ body: ['tiny phrase'], method: 'store' });
    expect(bytes.length).toBeLessThan(4096);
    const view = new Uint8Array(new ArrayBuffer(bytes.length + 64), 64, bytes.length);
    view.set(bytes);
    expect(textOf(extractOfficeText(view))).toContain('tiny phrase');
  });

  it('returns expected reasons without text (AC 7, 10)', () => {
    expect(extractOfficeText(encrypted())).toEqual({ ok: false, reason: 'ole-container' });
    expect(extractOfficeText(Buffer.from('plain text'))).toEqual({ ok: false, reason: 'not-zip' });
    expect(extractOfficeText(new Uint8Array(0))).toEqual({ ok: false, reason: 'not-zip' });
    expect(
      extractOfficeText(buildZip([{ name: 'word/document.xml', data: '<w:t>zip only</w:t>' }])),
    ).toEqual({ ok: false, reason: 'not-ooxml' });
    expect(extractOfficeText(docx({}))).toEqual({ ok: false, reason: 'empty' });
  });

  it.each<[CorruptKind, OfficeNoText]>([
    ['truncated', 'corrupt'],
    ['bad-eocd', 'corrupt'],
    ['bad-local-offset', 'corrupt'],
    ['bad-cd-signature', 'corrupt'],
    ['bad-deflate', 'corrupt'],
    ['entry-count', 'corrupt'],
    ['no-local-signature', 'not-zip'],
  ])('reports a %s archive as %s (AC 8)', (kind, reason) => {
    expect(extractOfficeText(corrupt(kind))).toEqual({ ok: false, reason });
  });

  it('refuses ZIP64, ZIP encryption and duplicate names (AC 8)', () => {
    expect(extractOfficeText(zip64('sizes'))).toEqual({ ok: false, reason: 'unsupported-zip' });
    expect(extractOfficeText(zip64('locator'))).toEqual({ ok: false, reason: 'unsupported-zip' });
    expect(extractOfficeText(zipEncrypted())).toEqual({ ok: false, reason: 'unsupported-zip' });
    expect(extractOfficeText(duplicateNames(true))).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('handles DOCTYPE: corrupt in the main part, partial text elsewhere (AC 8)', () => {
    expect(extractOfficeText(doctype('main'))).toEqual({ ok: false, reason: 'corrupt' });
    const header = extractOfficeText(doctype('header'));
    expect(header.ok && header.truncated).toBe(true);
    expect(textOf(header)).toContain('doctype safe body');
  });

  it('reads data-descriptor, mixed-case and fake-EOCD archives', () => {
    expect(textOf(extractOfficeText(dataDescriptor()))).toContain('descriptor phrase');
    expect(textOf(extractOfficeText(mixedCaseNames()))).toContain('mixed case phrase');
    expect(textOf(extractOfficeText(fakeEocdInComment()))).toContain('fake eocd phrase');
  });

  it('applies partial limit overrides', () => {
    const result = extractOfficeText(docx({ body: ['x'.repeat(500)] }), { maxRawChars: 100 });
    expect(result.ok && result.truncated).toBe(true);
    expect(textOf(result)).toHaveLength(100);
  });

  it('adds no keys to Object.prototype', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    textOf(extractOfficeText(protoPollution()));
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });
});

describe('zip bombs (AC 9, AC 18)', () => {
  let deflated: Buffer;

  beforeAll(() => {
    deflated = zeroBomb(80 * MIB);
  });

  it('gives up on a bombed main part with `limit`, in under 2 s', () => {
    const { value, ms } = timed(() => extractOfficeText(bomb(deflated, 'main')));
    expect(value).toEqual({ ok: false, reason: 'limit' });
    expect(ms).toBeLessThan(2_000);
  });

  it('keeps other text and flags truncation when a secondary part is bombed', () => {
    const { value, ms } = timed(() => extractOfficeText(bomb(deflated, 'header')));
    expect(value.ok && value.truncated).toBe(true);
    expect(textOf(value)).toContain('bomb body phrase');
    expect(ms).toBeLessThan(2_000);
  });

  it('rejects 1000 entries overlapping one bomb as corrupt, in under 200 ms', () => {
    const bytes = overlapBomb(deflated, 1000);
    const { value, ms } = timed(() => extractOfficeText(bytes));
    expect(value).toEqual({ ok: false, reason: 'corrupt' });
    expect(ms).toBeLessThan(200);
  });

  it('rejects stored entries overlapping one another', () => {
    expect(extractOfficeText(storedOverlap(50))).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('stops after the total budget: distinct bombs cost at most maxTotalBytes', () => {
    const sheets = Array.from({ length: 5 }, (_, i) => ({
      name: `Sheet${i + 1}`,
      rows: [[{ inline: `sheet ${i + 1} text` }]],
    }));
    const bombed = new Set([2, 3, 4, 5].map((n) => `xl/worksheets/sheet${n}.xml`));
    const bytes = buildZip(
      xlsxParts({ sheets }).map(([name, data]) =>
        bombed.has(name) ? { name, deflated, declaredSize: 512 } : { name, data },
      ),
    );
    const limits = officeLimits();
    const zip = readZip(bytes, limits);
    if (typeof zip === 'string') throw new Error(zip);
    const { value, ms } = timed(() => extractFromArchive(zip, limits));
    expect(value.ok && value.truncated).toBe(true);
    expect(textOf(value)).toContain('sheet 1 text');
    expect(textOf(value)).toContain('Sheet5');
    expect(zip.exhausted).toBe(true);
    expect(zip.readLog).toContain('xl/worksheets/sheet2.xml');
    expect(zip.readLog).toContain('xl/worksheets/sheet3.xml');
    expect(zip.readLog).not.toContain('xl/worksheets/sheet4.xml');
    expect(zip.readLog).not.toContain('xl/worksheets/sheet5.xml');
    expect(ms).toBeLessThan(2_000);
  });
});

describe('bounds (AC 18)', () => {
  it('extracts a generated 20 MB DOCX in under 3 s', () => {
    const bytes = largeDocx(20 * MIB, 'final phrase at the end');
    expect(bytes.length).toBeGreaterThan(19 * MIB);
    const { value, ms } = timed(() => extractOfficeText(bytes));
    expect(textOf(value)).toContain('final phrase at the end');
    expect(ms).toBeLessThan(3_000);
  });
});

describe('fuzz', () => {
  it('never throws across 500 seeded random byte flips of valid packages', () => {
    const random = prng(0x0ff1ce);
    const limits = officeLimits();
    const bases = [
      docx({
        body: ['fuzz body عربي'],
        headers: ['fuzz header'],
        footnotes: ['fuzz note'],
        textBox: 'fuzz box',
      }),
      docx({ body: ['stored fuzz body'], footers: ['stored footer'], method: 'store' }),
      xlsx({ sheets: [{ name: 'Fuzz', rows: [['shared', 12, { inline: 'inline' }]] }] }),
    ];
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    for (let i = 0; i < 500; i++) {
      const base = bases[i % bases.length];
      const bytes = Buffer.from(base);
      const flips = 1 + Math.floor(random() * 4);
      for (let f = 0; f < flips; f++) {
        const at = Math.floor(random() * bytes.length);
        bytes[at] ^= 1 + Math.floor(random() * 255);
      }
      const result = extractOfficeText(bytes);
      if (result.ok) {
        expect(typeof result.text).toBe('string');
        expect(result.text.length).toBeLessThanOrEqual(limits.maxRawChars);
      } else {
        expect(REASONS).toContain(result.reason);
      }
      const zip = readZip(bytes, limits);
      if (typeof zip !== 'string') extractFromArchive(zip, limits);
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });
});
