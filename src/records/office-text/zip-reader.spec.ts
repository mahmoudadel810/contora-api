import {
  corrupt,
  type CorruptKind,
  dataDescriptor,
  duplicateNames,
  fakeEocdInComment,
  longEntryName,
  mixedCaseNames,
  overlapBomb,
  storedOverlap,
  zeroBomb,
  zip64,
  type Zip64Kind,
  zipEncrypted,
} from '../../../test/helpers/ooxml-hostile.js';
import { buildZip, docx } from '../../seed/ooxml-sample.js';
import { officeLimits } from './limits.js';
import type { OfficeLimits } from './types.js';
import { readZip, type ZipArchive } from './zip-reader.js';

const KIB = 1024;

function open(bytes: Uint8Array, overrides: Partial<OfficeLimits> = {}): ZipArchive {
  const zip = readZip(bytes, officeLimits(overrides));
  if (typeof zip === 'string') throw new Error(`expected an archive, got ${zip}`);
  return zip;
}

function utf8(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString('utf8');
}

function cdOffsetOf(zip: Buffer): number {
  return zip.readUInt32LE(zip.length - 22 + 16);
}

describe('readZip structure', () => {
  it('reads stored and deflated entries by case-insensitive name, leading slash ignored', () => {
    const zip = open(
      buildZip([
        { name: 'Word/Doc.xml', data: '<a>deflated</a>' },
        { name: 'b.txt', data: 'stored', method: 'store' },
      ]),
    );
    expect(zip.names()).toEqual(['word/doc.xml', 'b.txt']);
    expect(zip.has('/WORD/DOC.XML')).toBe(true);
    expect(utf8(zip.read('word/doc.xml'))).toBe('<a>deflated</a>');
    expect(utf8(zip.read('B.TXT'))).toBe('stored');
  });

  it('percent-decodes item names so they meet decoded rel targets', () => {
    const zip = open(buildZip([{ name: 'word/m%C3%A9dia.xml', data: 'x' }]));
    expect(zip.has('word/média.xml')).toBe(true);
  });

  it('accepts an empty archive', () => {
    expect(open(buildZip([])).names()).toEqual([]);
  });

  it('uses central-directory sizes for entries with data descriptors', () => {
    const zip = open(dataDescriptor());
    expect(utf8(zip.read('word/document.xml'))).toContain('descriptor phrase');
  });

  it('matches names whatever their case', () => {
    const zip = open(mixedCaseNames());
    expect(zip.has('word/document.xml')).toBe(true);
    expect(utf8(zip.read('word/document.xml'))).toContain('mixed case phrase');
  });

  it('rejects duplicate names, exact or after case folding', () => {
    expect(readZip(duplicateNames(false), officeLimits())).toBe('corrupt');
    expect(readZip(duplicateNames(true), officeLimits())).toBe('corrupt');
  });

  it('rejects a name containing NUL', () => {
    expect(readZip(buildZip([{ name: 'a\0b.xml', data: 'x' }]), officeLimits())).toBe('corrupt');
  });

  it('rejects an entry name longer than 1,024 bytes', () => {
    expect(readZip(longEntryName(1025), officeLimits())).toBe('corrupt');
    const zip = open(longEntryName(1024));
    expect(utf8(zip.read(`${'n'.repeat(1020)}.xml`))).toBe('<a/>');
  });

  it('counts the name cap in bytes, not characters', () => {
    const arabic = `${'ع'.repeat(511)}.xml`;
    expect(readZip(buildZip([{ name: arabic, data: '<a/>' }]), officeLimits())).toBe('corrupt');
  });

  it('refuses ZIP encryption', () => {
    expect(readZip(zipEncrypted(), officeLimits())).toBe('unsupported-zip');
  });

  it.each<Zip64Kind>(['sizes', 'offset', 'locator', 'count'])('refuses ZIP64 (%s)', (kind) => {
    expect(readZip(zip64(kind), officeLimits())).toBe('unsupported-zip');
  });

  it.each<CorruptKind>([
    'truncated',
    'bad-eocd',
    'bad-local-offset',
    'bad-cd-signature',
    'entry-count',
    'no-local-signature',
  ])('reports %s as corrupt', (kind) => {
    expect(readZip(corrupt(kind), officeLimits())).toBe('corrupt');
  });

  it('refuses multi-disk archives and requires entries-on-disk to equal the total', () => {
    const entries = [{ name: 'a.xml', data: '<a/>' }];
    expect(readZip(buildZip(entries, { eocd: { disk: 1 } }), officeLimits())).toBe(
      'unsupported-zip',
    );
    expect(readZip(buildZip(entries, { eocd: { cdDisk: 2 } }), officeLimits())).toBe(
      'unsupported-zip',
    );
    expect(readZip(buildZip(entries, { eocd: { entriesOnDisk: 0 } }), officeLimits())).toBe(
      'corrupt',
    );
    expect(readZip(buildZip([{ ...entries[0], diskStart: 1 }]), officeLimits())).toBe(
      'unsupported-zip',
    );
  });

  it('requires the entries to end exactly at cdOffset + cdSize', () => {
    const entries = [{ name: 'a.xml', data: '<a/>' }];
    const exact = buildZip(entries);
    const cdSize = exact.readUInt32LE(exact.length - 22 + 12);
    expect(readZip(buildZip(entries, { eocd: { cdSize: cdSize - 1 } }), officeLimits())).toBe(
      'corrupt',
    );
    expect(readZip(buildZip(entries, { eocd: { cdSize: cdSize + 1 } }), officeLimits())).toBe(
      'corrupt',
    );
    const two = [...entries, { name: 'b.xml', data: '<b/>' }];
    expect(
      readZip(buildZip(two, { eocd: { entriesOnDisk: 1, totalEntries: 1 } }), officeLimits()),
    ).toBe('corrupt');
  });

  it('rejects local data running into the central directory', () => {
    const zip = buildZip([{ name: 'a.xml', data: '<a/>', compressedSize: 5000 }]);
    expect(readZip(zip, officeLimits())).toBe('corrupt');
  });

  it('rejects overlapping local ranges', () => {
    expect(readZip(overlapBomb(zeroBomb(64 * KIB), 5), officeLimits())).toBe('corrupt');
    expect(readZip(storedOverlap(3), officeLimits())).toBe('corrupt');
  });

  it('skips a fake EOCD inside the ZIP comment', () => {
    const zip = open(fakeEocdInComment());
    expect(utf8(zip.read('word/document.xml'))).toContain('fake eocd phrase');
  });

  it('finds no EOCD in a buffer shorter than one', () => {
    expect(readZip(new Uint8Array(10), officeLimits())).toBe('corrupt');
    expect(readZip(new Uint8Array(0), officeLimits())).toBe('corrupt');
  });

  it('works on a view that does not start at offset 0 of its buffer', () => {
    const bytes = docx({ body: ['offset phrase'] });
    const backing = new ArrayBuffer(bytes.length + 100);
    const view = new Uint8Array(backing, 100, bytes.length);
    view.set(bytes);
    expect(utf8(open(view).read('word/document.xml'))).toContain('offset phrase');
  });
});

describe('readZip caps', () => {
  it('limits the entry count and the central-directory size', () => {
    const three = buildZip([
      { name: 'a', data: 'a' },
      { name: 'b', data: 'b' },
      { name: 'c', data: 'c' },
    ]);
    expect(readZip(three, officeLimits({ maxEntries: 2 }))).toBe('limit');
    expect(readZip(three, officeLimits({ maxCentralDirBytes: 100 }))).toBe('limit');
    expect(typeof readZip(three, officeLimits({ maxEntries: 3 }))).toBe('object');
  });

  it('reads at most maxParts parts', () => {
    const zip = open(
      buildZip([
        { name: 'a', data: 'a' },
        { name: 'b', data: 'b' },
        { name: 'c', data: 'c' },
      ]),
      { maxParts: 2 },
    );
    expect(utf8(zip.read('a'))).toBe('a');
    expect(utf8(zip.read('b'))).toBe('b');
    expect(zip.read('c')).toBeNull();
    expect(zip.failure('c')).toBe('limit');
  });

  it('refuses a stored part larger than maxPartBytes rather than cutting it', () => {
    const zip = open(buildZip([{ name: 'big', data: 'x'.repeat(100), method: 'store' }]), {
      maxPartBytes: 50,
    });
    expect(zip.read('big')).toBeNull();
    expect(zip.failure('big')).toBe('limit');
  });

  it('bounds inflation by maxOutputLength, not by the declared size', () => {
    const zip = open(
      buildZip([{ name: 'bomb', deflated: zeroBomb(KIB * KIB), declaredSize: 10 }]),
      {
        maxPartBytes: 64 * KIB,
      },
    );
    expect(zip.read('bomb')).toBeNull();
    expect(zip.failure('bomb')).toBe('limit');
  });

  it('charges the full requested cap when an inflate fails', () => {
    const zip = open(
      buildZip([
        { name: 'bomb', deflated: zeroBomb(KIB * KIB) },
        { name: 'forty', data: 'a'.repeat(40 * KIB) },
        { name: 'small', data: 'c' },
      ]),
      { maxPartBytes: 64 * KIB, maxTotalBytes: 100 * KIB },
    );
    expect(zip.read('bomb')).toBeNull();
    expect(zip.read('forty')).toBeNull();
    expect(zip.failure('forty')).toBe('limit');
    expect(zip.exhausted).toBe(true);
    expect(zip.read('small')).toBeNull();
    expect(zip.failure('small')).toBe('limit');
  });

  it('charges stored parts against the total', () => {
    const zip = open(
      buildZip([
        { name: 'a', data: 'a'.repeat(100), method: 'store' },
        { name: 'b', data: 'b'.repeat(100), method: 'store' },
        { name: 'c', data: 'c', method: 'store' },
      ]),
      { maxTotalBytes: 150 },
    );
    expect(zip.read('a')?.length).toBe(100);
    expect(zip.read('b')).toBeNull();
    expect(zip.exhausted).toBe(true);
    expect(zip.read('c')).toBeNull();
    expect(zip.readLog).toEqual(['a', 'b']);
  });

  it('memoises reads: a part is materialised once however often it is asked for', () => {
    const zip = open(buildZip([{ name: 'a.xml', data: '<a/>' }]), { maxTotalBytes: 6 });
    const first = zip.read('a.xml');
    expect(zip.read('A.XML')).toBe(first);
    expect(zip.read('/a.xml')).toBe(first);
    expect(zip.readLog).toEqual(['a.xml']);
  });

  it('releases a read part without ever reading it again', () => {
    const zip = open(
      buildZip([
        { name: 'a.xml', data: '<a/>' },
        { name: 'b.xml', data: '<b/>' },
      ]),
    );
    expect(utf8(zip.read('a.xml'))).toBe('<a/>');
    zip.release('A.XML');
    expect(zip.read('a.xml')).toBeNull();
    expect(zip.failure('a.xml')).toBe('released');
    zip.release('b.xml');
    expect(utf8(zip.read('b.xml'))).toBe('<b/>');
    expect(zip.readLog).toEqual(['a.xml', 'b.xml']);
  });

  it('returns an empty part without inflating it', () => {
    const zip = open(buildZip([{ name: 'e.xml', deflated: new Uint8Array(0) }]));
    expect(zip.read('e.xml')?.length).toBe(0);
    expect(zip.failure('e.xml')).toBeUndefined();
  });

  it('never inflates with a cap below 1', () => {
    const zip = open(buildZip([{ name: 'a.xml', data: '<a/>' }]), { maxPartBytes: 0 });
    expect(zip.read('a.xml')).toBeNull();
    expect(zip.failure('a.xml')).toBe('limit');
  });

  it('treats an unknown compression method as an unreadable entry', () => {
    const bytes = buildZip([{ name: 'a.xml', data: '<a/>' }]);
    bytes.writeUInt16LE(12, cdOffsetOf(bytes) + 10);
    const zip = open(bytes);
    expect(zip.has('a.xml')).toBe(true);
    expect(zip.read('a.xml')).toBeNull();
    expect(zip.failure('a.xml')).toBe('corrupt');
  });

  it('reports a zlib data error as corrupt and a missing part as missing', () => {
    const zip = open(buildZip([{ name: 'bad.xml', deflated: Buffer.from([0xff, 0xff, 0xff]) }]));
    expect(zip.read('bad.xml')).toBeNull();
    expect(zip.failure('bad.xml')).toBe('corrupt');
    expect(zip.read('nope.xml')).toBeNull();
    expect(zip.failure('nope.xml')).toBe('missing');
    expect(zip.readLog).toEqual(['bad.xml']);
  });
});
