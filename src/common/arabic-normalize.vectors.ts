export interface TextVector {
  readonly input: string;
  readonly expected: string;
  readonly proves: string;
}

export interface RangeVector {
  readonly text: string;
  readonly q: string;
  readonly ranges: readonly (readonly [number, number])[];
}

export const NORMALIZE_VECTORS: readonly TextVector[] = [
  { input: 'أحمد', expected: 'احمد', proves: 'rule 1, hamza above' },
  { input: 'إحمد', expected: 'احمد', proves: 'rule 1, hamza below' },
  { input: 'آحمد', expected: 'احمد', proves: 'rule 1, madda' },
  { input: 'ٱلرحمن', expected: 'الرحمن', proves: 'rule 1, wasla' },
  { input: 'مستشفى', expected: 'مستشفي', proves: 'rule 2' },
  { input: 'مدرسة', expected: 'مدرسه', proves: 'rule 3' },
  { input: 'مسؤول', expected: 'مسوول', proves: 'rule 4, waw with hamza' },
  { input: 'مئة', expected: 'ميه', proves: 'rule 4, yeh with hamza, plus rule 3' },
  { input: 'شيء', expected: 'شيء', proves: 'rule 4, a standalone hamza stays' },
  {
    input: 'أَحْمَد',
    expected: 'احمد',
    proves: 'rule 5, harakat',
  },
  {
    input: 'الرَّحْمٰن',
    expected: 'الرحمن',
    proves: 'rule 5, superscript alef',
  },
  {
    input: 'كتــــاب',
    expected: 'كتاب',
    proves: 'rule 6, tatweel',
  },
  { input: '١٢٣', expected: '123', proves: 'rule 7, Arabic-Indic digits' },
  { input: '۴۵۶', expected: '456', proves: 'rule 7, Persian digits' },
  {
    input: 'کتاب یوم',
    expected: 'كتاب يوم',
    proves: 'rule 8, keheh and Farsi yeh',
  },
  { input: '  Report_Q3.PDF  ', expected: 'report_q3.pdf', proves: 'rule 9, lowercase and trim' },
  { input: 'ملف \t\n  جديد', expected: 'ملف جديد', proves: 'rule 9, whitespace collapse' },
  {
    input: 'Invoice فاتورة ٢٠٢٦-Q3',
    expected: 'invoice فاتوره 2026-q3',
    proves: 'mixed Arabic, English and digits',
  },
  {
    input: 'Café ÜBER straße',
    expected: 'café über straße',
    proves: 'non-Arabic text changes under rule 9 only',
  },
  { input: 'ـــ', expected: '', proves: 'empty after folding' },
  {
    input: 'İstanbul',
    expected: 'i̇stanbul',
    proves: 'full toLowerCase, parity with searchTextOf',
  },
  { input: 'أ', expected: 'ا', proves: 'rule 5 extended: a decomposed hamza folds' },
  { input: 'ﻻ', expected: 'ﻻ', proves: 'no NFKC: presentation forms stay' },
  {
    input: '( ) * + ? [ \\ ^ $ . | { }',
    expected: '( ) * + ? [ \\ ^ $ . | { }',
    proves: 'regex metacharacters survive; they are escaped at query time',
  },
  {
    input: 'ذۖلۭٟك',
    expected: 'ذلك',
    proves: 'rule 5 extended: Quranic marks and U+065F',
  },
];

export const STRIP_INVISIBLES_VECTORS: readonly TextVector[] = [
  { input: 'a\u0000b', expected: 'ab', proves: 'NUL is dropped' },
  { input: 'a\u000Bb', expected: 'ab', proves: 'a vertical tab is dropped, not a space' },
  { input: '\t', expected: '\t', proves: 'tab is kept' },
  { input: 'a\nb\rc', expected: 'a\nb\rc', proves: 'line feed and carriage return are kept' },
  { input: 'a\uD800b', expected: 'ab', proves: 'a lone high surrogate is dropped' },
  { input: 'a\uDC00b', expected: 'ab', proves: 'a lone low surrogate is dropped' },
  { input: '😀', expected: '😀', proves: 'an astral character is kept' },
  { input: 'a\u007F\u0085\u009Fb', expected: 'ab', proves: 'C1 controls and DEL are dropped' },
  { input: 'a؜b', expected: 'ab', proves: 'the Arabic letter mark is dropped' },
  {
    input: 'a​‌‍‎‏b',
    expected: 'ab',
    proves: 'zero-width and directional marks are dropped',
  },
  {
    input: 'a‪‫‬‭‮b',
    expected: 'ab',
    proves: 'embeddings and overrides are dropped',
  },
  { input: 'a⁦⁧⁨⁩b', expected: 'ab', proves: 'isolates are dropped' },
  { input: '﻿ab', expected: 'ab', proves: 'the byte-order mark is dropped' },
  { input: 'a­b', expected: 'ab', proves: 'the soft hyphen is dropped' },
  { input: 'a⁠⁡⁢⁣⁤b', expected: 'ab', proves: 'word joiner and invisible operators are dropped' },
  {
    input: 'أَحمد',
    expected: 'أَحمد',
    proves: 'letters and marks are not its business',
  },
];

export const SEARCH_KEY_VECTORS: readonly TextVector[] = [
  { input: 'a\u0000b', expected: 'ab', proves: 'NUL is dropped' },
  {
    input: '‏فاتورة‎',
    expected: 'فاتوره',
    proves: 'directional marks are dropped before folding',
  },
  { input: 'a\u000Bb', expected: 'ab', proves: 'a vertical tab is dropped, not collapsed' },
  { input: 'a ​ b', expected: 'a b', proves: 'a dropped character does not split a run' },
  { input: 'a َ b', expected: 'a b', proves: 'a removed mark does not split a run' },
  { input: 'a\uD800b', expected: 'ab', proves: 'a lone surrogate is dropped' },
  { input: '😀احمد', expected: '😀احمد', proves: 'an emoji is kept' },
  { input: '‏ـ ‎', expected: '', proves: 'empty after stripping and folding' },
];

export const FOLD_DIGITS_VECTORS: readonly TextVector[] = [
  { input: '٣٫٥', expected: '3٫5', proves: 'the Arabic decimal separator is untouched' },
  { input: 'abc', expected: 'abc', proves: 'non-digits are unchanged' },
  { input: '٠١٢٣٤٥٦٧٨٩', expected: '0123456789', proves: 'every Arabic-Indic digit' },
  {
    input: '۰۱۲۳۴۵۶۷۸۹',
    expected: '0123456789',
    proves: 'every Persian digit',
  },
  { input: 'أحمدة', expected: 'أحمدة', proves: 'letters are not folded' },
];

export const RANGE_VECTORS: readonly RangeVector[] = [
  { text: 'مُحَمَّدٌ', q: 'محمد', ranges: [[0, 9]] },
  { text: 'أَحْمَد علي', q: 'احمد', ranges: [[0, 7]] },
  { text: 'مدرسة 2026', q: 'مدرسه', ranges: [[0, 5]] },
  { text: 'Invoice ACME', q: 'acme', ranges: [[8, 12]] },
  { text: 'a(b', q: '(', ranges: [[1, 2]] },
  { text: 'İx', q: 'x', ranges: [[1, 2]] },
  { text: 'İx', q: 'i', ranges: [[0, 1]] },
  { text: '😀احمد', q: 'احمد', ranges: [[2, 6]] },
];
