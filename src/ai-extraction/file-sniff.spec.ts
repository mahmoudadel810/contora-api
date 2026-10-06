import { completeUtf8Prefix, sniffKind } from './file-sniff.js';

const bytes = (...values: number[]) => Buffer.from(values);

describe('sniffKind ("the declared type narrows, the bytes decide")', () => {
  it.each([
    ['a PDF by its magic bytes', Buffer.from('%PDF-1.7\n...'), 'application/pdf', 'pdf'],
    ['a PDF declared as something else', Buffer.from('%PDF-1.4'), 'text/plain', 'pdf'],
    [
      'a ZIP (DOCX) by its magic bytes',
      bytes(0x50, 0x4b, 0x03, 0x04, 0x14),
      'application/zip',
      'zip',
    ],
    ['plain UTF-8 text', Buffer.from('Invoice 42\nAmount 10'), 'text/plain', 'text'],
    ['text with a charset parameter', Buffer.from('a,b\n1,2'), 'text/csv; charset=utf-8', 'text'],
    ['markdown, upper case', Buffer.from('# Contract'), 'TEXT/MARKDOWN', 'text'],
    ['Arabic UTF-8 text', Buffer.from('فاتورة رقم ٤٢'), 'text/plain', 'text'],
    ['an empty text file', Buffer.alloc(0), 'text/plain', 'text'],
  ])('%s', (_name, head, declared, expected) => {
    expect(sniffKind(head, declared, true)).toBe(expected);
  });

  it.each([
    [
      'PNG bytes behind a .pdf name',
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      'application/pdf',
    ],
    ['JPEG bytes', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['WEBP bytes', Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'), 'image/webp'],
    ['text bytes declared as an octet stream', Buffer.from('hello'), 'application/octet-stream'],
    ['text bytes declared as HTML', Buffer.from('<p>hi</p>'), 'text/html'],
    ['a NUL byte in declared text', Buffer.from('abc\u0000def'), 'text/plain'],
    ['invalid UTF-8 in declared text', bytes(0x61, 0xff, 0xfe, 0x62), 'text/plain'],
    ['a UTF-16 file (NUL bytes)', Buffer.from('﻿hi', 'utf16le'), 'text/plain'],
  ])('refuses %s', (_name, head, declared) => {
    expect(sniffKind(head, declared, true)).toBeNull();
  });

  it('accepts a multi-byte character cut at the end of the sniffed head (more bytes follow)', () => {
    const full = Buffer.from('abc ع');
    const cut = full.subarray(0, full.length - 1);
    expect(sniffKind(cut, 'text/plain', false)).toBe('text');
    expect(sniffKind(cut, 'text/plain', true)).toBeNull();
  });
});

describe('completeUtf8Prefix', () => {
  it('drops an incomplete trailing sequence only', () => {
    const text = Buffer.from('aع€😀');
    expect(completeUtf8Prefix(text)).toEqual(text);
    expect(completeUtf8Prefix(text.subarray(0, text.length - 1)).toString()).toBe('aع€');
    expect(completeUtf8Prefix(text.subarray(0, text.length - 3)).toString()).toBe('aع€');
    expect(completeUtf8Prefix(text.subarray(0, 2)).toString()).toBe('a');
  });
});
