import {
  foldDigits,
  foldWithOffsets,
  normalizeArabic,
  searchKey,
  SEARCH_KEY_VERSION,
  stripInvisibles,
} from './arabic-normalize.js';
import {
  FOLD_DIGITS_VECTORS,
  NORMALIZE_VECTORS,
  RANGE_VECTORS,
  SEARCH_KEY_VECTORS,
  STRIP_INVISIBLES_VECTORS,
} from './arabic-normalize.vectors.js';

describe('arabic-normalize', () => {
  it('starts at key version 1', () => {
    expect(SEARCH_KEY_VERSION).toBe(1);
  });

  describe('normalizeArabic (T1)', () => {
    it.each(NORMALIZE_VECTORS)('$proves: $input', ({ input, expected }) => {
      expect(normalizeArabic(input)).toBe(expected);
    });

    it.each(NORMALIZE_VECTORS)('is idempotent: $input', ({ input }) => {
      const once = normalizeArabic(input);
      expect(normalizeArabic(once)).toBe(once);
    });

    it('matches the reference examples', () => {
      const key = normalizeArabic('احمد');
      for (const variant of ['أحمد', 'إحمد', 'آحمد', 'أَحْمَد']) {
        expect(normalizeArabic(variant)).toBe(key);
      }
      expect(normalizeArabic('مدرسة')).toBe(normalizeArabic('مدرسه'));
    });

    it('keeps the accepted non-match: the two spellings of mas’ul stay apart', () => {
      expect(normalizeArabic('مسؤول')).toBe('مسوول');
      expect(normalizeArabic('مسئول')).toBe('مسيول');
    });
  });

  describe('stripInvisibles', () => {
    it.each(STRIP_INVISIBLES_VECTORS)('$proves', ({ input, expected }) => {
      expect(stripInvisibles(input)).toBe(expected);
    });
  });

  describe('searchKey', () => {
    it.each(SEARCH_KEY_VECTORS)('$proves', ({ input, expected }) => {
      expect(searchKey(input)).toBe(expected);
    });

    it.each([...NORMALIZE_VECTORS, ...SEARCH_KEY_VECTORS])('is idempotent: $input', ({ input }) => {
      const once = searchKey(input);
      expect(searchKey(once)).toBe(once);
    });

    it('leaves no C0 or C1 control but tab, line feed and carriage return in a key', () => {
      let every = '';
      for (let unit = 0; unit <= 0x9f; unit += 1) every += String.fromCharCode(unit);
      const key = stripInvisibles(every);
      for (const char of key) {
        const unit = char.charCodeAt(0);
        const control = unit < 0x20 || (unit >= 0x7f && unit <= 0x9f);
        expect(control && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d).toBe(false);
      }
      expect(searchKey(every)).not.toContain('\u0000');
    });

    it.runIf(process.env.SEARCH_PERF === '1')('folds 100k characters in under 20 ms', () => {
      const text = 'أَحْمَد Invoice ١٢٣ مدرسة '.repeat(4000).slice(0, 100_000);
      searchKey(text);
      const started = performance.now();
      searchKey(text);
      const elapsed = performance.now() - started;
      console.log(`searchKey over ${text.length} characters: ${elapsed.toFixed(2)} ms`);
      expect(elapsed).toBeLessThan(20);
    });
  });

  describe('foldDigits', () => {
    it.each(FOLD_DIGITS_VECTORS)('$proves', ({ input, expected }) => {
      expect(foldDigits(input)).toBe(expected);
    });
  });

  describe('foldWithOffsets', () => {
    const fixtures = [
      ...NORMALIZE_VECTORS.map((v) => v.input),
      ...STRIP_INVISIBLES_VECTORS.map((v) => v.input),
      ...SEARCH_KEY_VECTORS.map((v) => v.input),
      ...RANGE_VECTORS.map((v) => v.text),
      '',
      '   ',
      ' ​َ ',
      '😀 😀',
      'a\u000B \u000Bb',
      'İİ İ',
      'مُذَكِّرَة داخليــة',
    ];

    it.each(fixtures)('folds exactly as searchKey: %j', (text) => {
      expect(foldWithOffsets(text).folded).toBe(searchKey(text));
    });

    it.each(fixtures)('has one offset per folded unit plus the length: %j', (text) => {
      const { folded, offsets } = foldWithOffsets(text);
      expect(offsets).toHaveLength(folded.length + 1);
      expect(offsets[offsets.length - 1]).toBe(text.length);
    });

    it.each(fixtures)('has non-decreasing offsets, never at a low surrogate: %j', (text) => {
      const { offsets } = foldWithOffsets(text);
      for (let i = 1; i < offsets.length; i += 1) {
        expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
      }
      for (const offset of offsets.slice(0, -1)) {
        const unit = text.charCodeAt(offset);
        expect(unit >= 0xdc00 && unit <= 0xdfff).toBe(false);
      }
    });

    it('points each folded unit at the code point that produced it', () => {
      expect(foldWithOffsets('أَحْمَد علي')).toEqual({
        folded: 'احمد علي',
        offsets: [0, 2, 4, 6, 7, 8, 9, 10, 11],
      });
      expect(foldWithOffsets('😀احمد')).toEqual({
        folded: '😀احمد',
        offsets: [0, 0, 2, 3, 4, 5, 6],
      });
      expect(foldWithOffsets('İx')).toEqual({
        folded: 'i̇x',
        offsets: [0, 0, 1, 2],
      });
    });

    it('collapses a whitespace run to its first character and trims the ends', () => {
      expect(foldWithOffsets(' a ​\t b ')).toEqual({
        folded: 'a b',
        offsets: [1, 2, 6, 8],
      });
    });
  });
});

describe('arabic-normalize: behaviour relied on by AI extraction', () => {
  it('foldDigits maps only Arabic-Indic and Persian digits, separators untouched', () => {
    expect(foldDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(foldDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(foldDigits('٥٬٠٠٣٫٣٦ ر.س')).toBe('5٬003٫36 ر.س');
    expect(foldDigits('Invoice 12 أ')).toBe('Invoice 12 أ');
  });

  it('stripInvisibles removes bidi controls, zero-width characters, the BOM and the soft hyphen', () => {
    expect(stripInvisibles('‫فاتورة‬‏')).toBe('فاتورة');
    expect(stripInvisibles('a​b⁠c﻿d­e')).toBe('abcde');
    expect(stripInvisibles('⁧x⁩؜')).toBe('x');
  });

  it('stripInvisibles keeps tab, line feed and carriage return and applies no NFKC', () => {
    expect(stripInvisibles('a\u0000b\u0007c\u0085d')).toBe('abcd');
    expect(stripInvisibles('line 1\r\n\tline 2')).toBe('line 1\r\n\tline 2');
    expect(stripInvisibles('ﻻ')).toBe('ﻻ');
  });

  it('normalizeArabic unifies letters and removes marks', () => {
    expect(normalizeArabic('أحمد إبراهيم آمنة ٱلله')).toBe('احمد ابراهيم امنه الله');
    expect(normalizeArabic('مؤسسة شئون')).toBe('موسسه شيون');
    expect(normalizeArabic('کتاب یک')).toBe('كتاب يك');
    expect(normalizeArabic('مُحَمَّدٌ')).toBe('محمد');
    expect(normalizeArabic('شـــركة')).toBe('شركه');
    expect(normalizeArabic('  Invoice   ف-٢٠٢٦/٠٨٨\n')).toBe('invoice ف-2026/088');
  });

  it('removes invisibles before folding through searchKey', () => {
    expect(searchKey('‫شركة​ النخبة‬')).toBe('شركه النخبه');
  });

  it('is idempotent on mixed samples', () => {
    for (const sample of ['أَحْمَد ٱلـــمُؤسسة ١٢٣', 'Mixed النص Text ۴۵', ' a  b ']) {
      const once = normalizeArabic(sample);
      expect(normalizeArabic(once)).toBe(once);
    }
  });
});
