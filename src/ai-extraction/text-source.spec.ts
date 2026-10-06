import { cutAtLineBreak, cutCodePoints, foldForMatch } from './text-clean.js';
import { PLAIN_TEXT_READ_BYTES, PlainTextSource } from './text-source.js';

const source = new PlainTextSource();
const live = new AbortController().signal;
const text = (content: string, size?: number) => {
  const bytes = Buffer.from(content);
  return {
    bytes,
    info: { kind: 'text' as const, mimeType: 'text/plain', size: size ?? bytes.length },
  };
};

describe('PlainTextSource', () => {
  it('accepts only the text kind', () => {
    expect(source.supports('text')).toBe(true);
    expect(source.supports('pdf')).toBe(false);
    expect(source.supports('zip')).toBe(false);
    expect(source.maxBytes('text')).toBe(PLAIN_TEXT_READ_BYTES);
  });

  it('returns UTF-8 text with invisible characters stripped and NFKC applied', async () => {
    const { bytes, info } = text('Invoice‏ 42‮\nﻻ total');
    const result = await source.extract(bytes, info, live);
    expect(result).toEqual({
      ok: true,
      text: 'Invoice 42\nلا total',
      truncated: false,
      source: 'plain',
    });
  });

  it('marks text read only in part as truncated, dropping a cut character', async () => {
    const full = Buffer.from('abc ع');
    const result = await source.extract(
      full.subarray(0, full.length - 1),
      { kind: 'text', mimeType: 'text/plain', size: full.length },
      live,
    );
    expect(result).toEqual({ ok: true, text: 'abc ', truncated: true, source: 'plain' });
  });

  it.each([
    ['a NUL byte', Buffer.from('a\u0000b'), 'unsupported'],
    ['invalid UTF-8', Buffer.from([0x61, 0xff]), 'unsupported'],
    ['only whitespace', Buffer.from(' \n\t '), 'no_text'],
    ['an empty file', Buffer.alloc(0), 'no_text'],
  ])('refuses %s', async (_name, bytes, reason) => {
    const result = await source.extract(
      bytes,
      { kind: 'text', mimeType: 'text/plain', size: bytes.length },
      live,
    );
    expect(result).toEqual({ ok: false, reason });
  });

  it('answers unsupported for PDF and ZIP, and timeout once the deadline fired', async () => {
    const bytes = Buffer.from('%PDF-1.7');
    expect(
      await source.extract(bytes, { kind: 'pdf', mimeType: 'application/pdf', size: 8 }, live),
    ).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    const aborted = AbortSignal.abort();
    expect(
      await source.extract(
        Buffer.from('x'),
        { kind: 'text', mimeType: 'text/plain', size: 1 },
        aborted,
      ),
    ).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });
});

describe('text helpers', () => {
  it('cuts at the last line break within the limit', () => {
    expect(cutAtLineBreak('one\ntwo\nthree', 9)).toEqual({ text: 'one\ntwo', truncated: true });
    expect(cutAtLineBreak('short', 10)).toEqual({ text: 'short', truncated: false });
  });

  it('cuts without a line break and never splits a surrogate pair', () => {
    expect(cutAtLineBreak('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(cutAtLineBreak('ab😀cd', 3)).toEqual({ text: 'ab', truncated: true });
  });

  it('cuts by code point', () => {
    expect(cutCodePoints('😀😀😀', 2)).toBe('😀😀');
    expect(cutCodePoints('abc', 5)).toBe('abc');
  });

  it('folds digits, Arabic letter variants, harakat, tatweel, case and whitespace', () => {
    expect(foldForMatch('  أحمـــد   ١٢٣  ')).toBe(foldForMatch('احمد 123'));
    expect(foldForMatch('مُحَمَّد')).toBe('محمد');
    expect(foldForMatch('ACME‏ Corp')).toBe('acme corp');
  });
});
