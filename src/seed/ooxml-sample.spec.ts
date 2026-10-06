import { crc32, inflateRawSync } from 'node:zlib';
import { buildZip, docx } from './ooxml-sample.js';

describe('ooxml-sample buildZip', () => {
  it('writes local headers, a central directory and an EOCD with correct CRCs', () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'hello', method: 'store' },
      { name: 'b.xml', data: '<b>deflated</b>' },
    ]);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
    const cdOffset = zip.readUInt32LE(eocd + 16);
    expect(cdOffset + zip.readUInt32LE(eocd + 12)).toBe(eocd);

    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(14)).toBe(crc32('hello'));
    expect(zip.subarray(30 + 5, 30 + 5 + 5).toString()).toBe('hello');

    const second = cdOffset + 46 + 5;
    expect(zip.readUInt32LE(second)).toBe(0x02014b50);
    expect(zip.readUInt16LE(second + 10)).toBe(8);
    const local = zip.readUInt32LE(second + 42);
    const size = zip.readUInt32LE(second + 20);
    const start = local + 30 + zip.readUInt16LE(local + 26);
    expect(inflateRawSync(zip.subarray(start, start + size)).toString()).toBe('<b>deflated</b>');
  });

  it('writes a DOCX with its package parts first', () => {
    const bytes = docx({ body: ['x'] });
    expect(bytes.subarray(30, 30 + '[Content_Types].xml'.length).toString()).toBe(
      '[Content_Types].xml',
    );
  });
});
