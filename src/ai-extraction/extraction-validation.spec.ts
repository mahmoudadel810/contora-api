import type { FieldDefinition } from './deps.js';
import type { FieldSuggestion } from './extraction.types.js';
import { planExtraction } from './extraction-schema.js';
import {
  bandOf,
  clampConfidence,
  storedSnippet,
  toUtcInstant,
  validateAnswer,
  validateField,
} from './extraction-validation.js';
import { foldForMatch } from './text-clean.js';

const field = (overrides: Partial<FieldDefinition> & Pick<FieldDefinition, 'type'>) =>
  ({ key: 'f', label: 'F', required: false, ...overrides }) as FieldDefinition;

const TEXT = field({ type: 'text', maxLength: 20 });
const TEXTAREA = field({ type: 'textarea', maxLength: 500 });
const EMAIL = field({ type: 'email' });
const URL_FIELD = field({ type: 'url' });
const PHONE = field({ type: 'phone' });
const NUM = field({ type: 'number', min: 0, max: 1_000_000 });
const CUR = field({ type: 'currency', currency: 'SAR', min: 0 });
const PCT = field({ type: 'percentage' });
const DATE = field({ type: 'date' });
const DATETIME = field({ type: 'datetime' });
const TIME = field({ type: 'time' });
const BOOL = field({ type: 'boolean' });
const SELECT = field({ type: 'select', options: ['Open', 'Paid'] });
const RADIO = field({ type: 'radio', options: ['Gold', 'Silver'] });
const MULTI = field({ type: 'multiselect', options: ['Legal', 'Finance', 'HR'] });
const CHECKS = field({ type: 'checkboxes', options: ['Safety', 'Access'] });

type Expected =
  | { status: 'filled'; value: unknown }
  | { status: 'not_found' }
  | { status: 'invalid'; reason: string };

const filled = (value: unknown): Expected => ({ status: 'filled', value });
const notFound: Expected = { status: 'not_found' };
const bad = (reason: string): Expected => ({ status: 'invalid', reason });

const VECTORS: Array<[string, FieldDefinition, unknown, unknown, Expected, string?]> = [
  ['ASCII integer', NUM, '1250', 'Total: 1250', filled(1250)],
  ['decimal point', NUM, '1250.75', 'Total 1250.75', filled(1250.75)],
  ['Arabic-Indic digits', NUM, '١٢٥٠', 'المجموع ١٢٥٠', filled(1250)],
  ['Persian digits', NUM, '۱۲۵۰', 'جمع ۱۲۵۰', filled(1250)],
  ['Arabic-Indic value, U+066B in the snippet', NUM, '١٢.٥', 'المبلغ ١٢٫٥', filled(12.5)],
  ['U+066B as the decimal point is refused', NUM, '١٢٫٥', 'المبلغ ١٢٫٥', bad('TYPE')],
  ['thousands comma refused', NUM, '1,250', 'Total 1,250', bad('TYPE')],
  ['European separators refused', NUM, '1.234,56', 'Total 1.234,56', bad('TYPE')],
  ['currency sign refused', CUR, '$120', 'Total $120', bad('TYPE')],
  ['percent sign refused', PCT, '15%', 'VAT 15%', bad('TYPE')],
  ['space grouping refused', NUM, '1 250', 'Total 1 250', bad('TYPE')],
  ['exponent refused', NUM, '1e3', 'Total 1000', bad('TYPE')],
  ['a JSON number is not the schema type', NUM, 1250, 'Total 1250', bad('TYPE')],
  ['below the minimum', NUM, '-5', 'Balance -5', bad('OUT_OF_RANGE')],
  ['above the maximum', NUM, '2000000', 'Total 2000000', bad('OUT_OF_RANGE')],
  ['percentage above 100', PCT, '120', 'Growth 120', bad('OUT_OF_RANGE')],
  ['currency with three decimals', CUR, '10.125', 'SAR 10.125', bad('DECIMALS')],
  ['currency with two decimals', CUR, '10.50', 'SAR 10.50', filled(10.5)],
  ['0.5 matches .5 in the snippet', PCT, '0.5', 'rate .5%', filled(0.5)],
  ['leading plus sign', NUM, '+42', '42 units', filled(42)],
  ['number not in its snippet', NUM, '1250', 'Total: 1350', bad('VALUE_NOT_IN_SNIPPET')],
  [
    'a number inside a date is not the value',
    NUM,
    '60',
    'Issued 2026-04-21',
    bad('VALUE_NOT_IN_SNIPPET'),
  ],
  [
    'a part of a longer number is not the value',
    NUM,
    '125',
    'Total 1250',
    bad('VALUE_NOT_IN_SNIPPET'),
  ],
  ['a leading-zero token is not the value', NUM, '4', 'Month 04', bad('VALUE_NOT_IN_SNIPPET')],
  ['0.5 needs a 0.5 or .5 token', PCT, '0.5', 'rate 5%', bad('VALUE_NOT_IN_SNIPPET')],
  ['0.5 matches 0.50 in the snippet', PCT, '0.5', 'rate 0.50%', filled(0.5)],
  ['thousands commas in the snippet are removed', NUM, '1250.5', 'Total 1,250.50', filled(1250.5)],
  ['U+066C thousands separator in the snippet', NUM, '1250', 'المجموع ١٬٢٥٠', filled(1250)],
  ['one token of several in the snippet', NUM, '42', 'Order 7, qty 42, due 2026-04-21', filled(42)],
  ['empty string is not found', NUM, '', 'x', notFound],
  ['whitespace is not found', NUM, '   ', 'x', notFound],
  ['null is not found', NUM, null, null, notFound],
  ['ISO date', DATE, '2026-03-15', 'Due 2026-03-15', filled('2026-03-15')],
  ['Arabic-Indic date', DATE, '٢٠٢٦-٠٣-١٥', 'الاستحقاق ٢٠٢٦-٠٣-١٥', filled('2026-03-15')],
  ['impossible calendar date', DATE, '2026-02-30', 'Due 2026-02-30', bad('DATE_FORMAT')],
  ['day/month order text', DATE, '15/03/2026', 'Due 15/03/2026', bad('DATE_FORMAT')],
  ['Hijri text', DATE, '١٥ رمضان ١٤٤٧', 'التاريخ ١٥ رمضان ١٤٤٧', bad('DATE_FORMAT')],
  [
    'datetime in UTC',
    DATETIME,
    '2026-03-15T10:30:00Z',
    'At 2026-03-15T10:30:00Z',
    filled('2026-03-15T10:30:00.000Z'),
  ],
  [
    'datetime with +03:00',
    DATETIME,
    '2026-03-15T13:30+03:00',
    'At 2026-03-15T13:30+03:00',
    filled('2026-03-15T10:30:00.000Z'),
  ],
  [
    'datetime with -05:00',
    DATETIME,
    '2026-03-15T05:30:00-05:00',
    'At 2026-03-15T05:30:00-05:00',
    filled('2026-03-15T10:30:00.000Z'),
  ],
  [
    'offset crossing midnight',
    DATETIME,
    '2026-03-01T01:00:00+03:00',
    '2026-03-01T01:00:00+03:00',
    filled('2026-02-28T22:00:00.000Z'),
  ],
  [
    'datetime without a zone',
    DATETIME,
    '2026-03-15T10:30:00',
    'At 2026-03-15T10:30:00',
    bad('DATE_FORMAT'),
  ],
  [
    'datetime with an impossible offset',
    DATETIME,
    '2026-03-15T10:30+15:00',
    '10:30+15:00',
    bad('DATE_FORMAT'),
  ],
  ['24 h time', TIME, '14:05', 'Arrival 14:05', filled('14:05')],
  ['12 h time refused', TIME, '2:05 PM', 'Arrival 2:05 PM', bad('TIME_FORMAT')],
  ['24:00 refused', TIME, '24:00', 'Until 24:00', bad('TIME_FORMAT')],
  ['Arabic-Indic time', TIME, '١٤:٠٥', 'الوصول ١٤:٠٥', filled('14:05')],
  ['plain text', TEXT, 'Acme Corp', 'Supplier: Acme Corp', filled('Acme Corp')],
  [
    'bidi and zero-width marks stripped',
    TEXT,
    'Acme‏ Corp',
    'Supplier: Acme Corp',
    filled('Acme Corp'),
  ],
  ['whitespace collapsed on one line', TEXT, 'Acme   Corp', 'Acme Corp', filled('Acme Corp')],
  [
    'longer than maxLength',
    TEXT,
    'A very long supplier name here',
    'A very long supplier name here',
    bad('TOO_LONG'),
  ],
  [
    'text value not in its snippet',
    TEXT,
    'Globex',
    'Supplier: Acme Corp',
    bad('VALUE_NOT_IN_SNIPPET'),
  ],
  [
    'snippet not in the document',
    TEXT,
    'Initech',
    'Supplier: Initech',
    bad('SNIPPET_NOT_FOUND'),
    'Supplier: Acme Corp',
  ],
  [
    'Arabic letter variants fold (teh marbuta, hamza)',
    TEXT,
    'شركة الأمل',
    'المورد: شركه الامل',
    filled('شركة الأمل'),
  ],
  ['harakat and tatweel fold', TEXT, 'محمد', 'السيد مُحَمَّـد', filled('محمد')],
  ['case folds', TEXT, 'ACME', 'acme corp', filled('ACME')],
  ['empty snippet', TEXT, 'Acme', '', bad('SNIPPET_NOT_FOUND'), 'Acme'],
  ['missing snippet', TEXT, 'Acme', null, bad('SNIPPET_NOT_FOUND'), 'Acme'],
  ['a number for a text field', TEXT, 42, '42', bad('TYPE')],
  [
    'textarea keeps its line breaks',
    TEXTAREA,
    'Line one\nLine two',
    'Line one\nLine two',
    filled('Line one\nLine two'),
  ],
  ['email lower-cased', EMAIL, 'Info@Acme.COM', 'Contact: Info@Acme.COM', filled('info@acme.com')],
  ['not an email', EMAIL, 'info at acme', 'info at acme', bad('PATTERN')],
  [
    'https URL',
    URL_FIELD,
    'https://acme.example/portal',
    'Portal https://acme.example/portal',
    filled('https://acme.example/portal'),
  ],
  ['ftp URL refused', URL_FIELD, 'ftp://acme.example', 'ftp://acme.example', bad('PATTERN')],
  [
    'grouped phone number',
    PHONE,
    '+966 50 123 4567',
    'Tel +966 50 123 4567',
    filled('+966 50 123 4567'),
  ],
  [
    'Arabic-Indic phone against a grouped snippet',
    PHONE,
    '+٩٦٦٥٠١٢٣٤٥٦٧',
    'هاتف +٩٦٦ ٥٠ ١٢٣ ٤٥٦٧',
    filled('+966501234567'),
  ],
  [
    'phone digits not in the snippet',
    PHONE,
    '+966501234568',
    'Tel +966 50 123 4567',
    bad('VALUE_NOT_IN_SNIPPET'),
  ],
  ['not a phone number', PHONE, 'call me', 'call me', bad('PATTERN')],
  ['listed option', SELECT, 'Paid', 'Status: Paid', filled('Paid')],
  ['option in another case', SELECT, 'paid', 'Status: paid', bad('NOT_IN_OPTIONS')],
  ['option not listed', SELECT, 'Overdue', 'Status: Overdue', bad('NOT_IN_OPTIONS')],
  ['radio option', RADIO, 'Gold', 'Tier Gold', filled('Gold')],
  [
    'multi-choice de-duplicated',
    MULTI,
    ['Legal', 'Finance', 'Legal'],
    'Legal and Finance',
    filled(['Legal', 'Finance']),
  ],
  ['empty multi-choice is not found', MULTI, [], 'x', notFound],
  [
    'multi-choice with an unlisted option',
    MULTI,
    ['Legal', 'Sales'],
    'Legal, Sales',
    bad('NOT_IN_OPTIONS'),
  ],
  ['a string for a multi-choice field', MULTI, 'Legal', 'Legal', bad('TYPE')],
  ['checkboxes', CHECKS, ['Safety'], 'Checks: Safety', filled(['Safety'])],
  [
    'choice with a snippet not in the document',
    SELECT,
    'Paid',
    'Status: Paid',
    bad('SNIPPET_NOT_FOUND'),
    'Status: Open',
  ],
  ['boolean true', BOOL, true, 'Signed: yes', filled(true)],
  ['boolean false', BOOL, false, 'Signed: no', filled(false)],
  ['a string for a boolean', BOOL, 'true', 'Signed: true', bad('TYPE')],
  [
    'invisible characters in the document',
    TEXT,
    'Acme Corp',
    'Acme Corp',
    filled('Acme Corp'),
    'Supplier: Acme​ Corp',
  ],
];

describe('validateField', () => {
  it('has at least 60 vectors', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(60);
  });

  it.each(VECTORS)('%s', (_name, definition, value, snippet, expected, documentText) => {
    const text = documentText ?? (typeof snippet === 'string' ? snippet : '');
    const result = validateField(
      definition,
      { value, confidence: 0.9, sourceSnippet: snippet },
      foldForMatch(text),
    );
    expect(result.status).toBe(expected.status);
    if (expected.status === 'filled') {
      expect(result.value).toEqual(expected.value);
      expect(result.reason).toBeNull();
      expect(result.band).toBe('high');
    } else {
      expect(result).toMatchObject({
        value: null,
        confidence: null,
        band: null,
        sourceSnippet: null,
      });
      expect(result.reason).toBe(expected.status === 'invalid' ? expected.reason : null);
    }
  });

  it('answers TYPE for an answer that is not an object', () => {
    expect(validateField(TEXT, 'Acme', foldForMatch('Acme')).reason).toBe('TYPE');
    expect(validateField(TEXT, undefined, foldForMatch('Acme')).reason).toBe('TYPE');
  });
});

describe('confidence and band', () => {
  it.each([
    [0.9, 0.9, 'high'],
    [0.85, 0.85, 'high'],
    [0.84, 0.84, 'medium'],
    [0.6, 0.6, 'medium'],
    [0.59, 0.59, 'low'],
    [0.876, 0.88, 'high'],
    [1.5, 1, 'high'],
    [-0.2, 0, 'low'],
    ['high', 0, 'low'],
  ])('confidence %s → %s (%s)', (raw, clamped, band) => {
    expect(clampConfidence(raw)).toBe(clamped);
    expect(bandOf(clampConfidence(raw))).toBe(band);
  });
});

describe('stored snippet', () => {
  it('has no bidi or zero-width characters and ends on a whole code point', () => {
    const long = `‫Invoice​ ${'😀'.repeat(130)}`;
    const stored = storedSnippet(long);
    expect(stored).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/);
    expect(Array.from(stored)).toHaveLength(120);
    const last = stored.charCodeAt(stored.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('is checked on the full snippet before the cut', () => {
    const document = `Notes: ${'x'.repeat(150)} END`;
    const snippet = document.slice(7);
    const result = validateField(
      field({ type: 'textarea', maxLength: 500 }),
      { value: snippet, confidence: 0.7, sourceSnippet: snippet },
      foldForMatch(document),
    );
    expect(result.status).toBe('filled');
    expect(Array.from(result.sourceSnippet ?? '')).toHaveLength(120);
  });
});

describe('toUtcInstant', () => {
  it.each([
    ['2026-03-15T10:30Z', '2026-03-15T10:30:00.000Z'],
    ['2026-03-15T10:30:15.5+01:00', '2026-03-15T09:30:15.500Z'],
    ['2026-02-29T10:00+00:00', null],
    ['2026-03-15T10:30', null],
  ])('%s → %s', (input, expected) => {
    expect(toUtcInstant(input)).toBe(expected);
  });
});

describe('validateAnswer', () => {
  it('returns the fields in definition order with the planned skips, and never the raw value', () => {
    const fields: FieldDefinition[] = [
      { key: 'owner', label: 'Owner', type: 'user', required: false },
      { key: 'supplier', label: 'Supplier', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'number', required: true },
    ];
    const plan = planExtraction(fields, 24);
    const result = validateAnswer(
      fields,
      plan,
      {
        supplier: { value: 'Acme', confidence: 0.95, sourceSnippet: 'Supplier: Acme' },
        amount: { value: 'one hundred', confidence: 0.95, sourceSnippet: 'one hundred' },
      },
      'Supplier: Acme\nAmount: one hundred',
    );
    expect(result.map((r: FieldSuggestion) => [r.key, r.status, r.reason])).toEqual([
      ['owner', 'skipped', 'USER_FIELD'],
      ['supplier', 'filled', null],
      ['amount', 'invalid', 'TYPE'],
    ]);
    expect(JSON.stringify(result)).not.toContain('one hundred');
  });
});
