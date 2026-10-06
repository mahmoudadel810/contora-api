import {
  canonicalInstant,
  effectiveBounds,
  foldDigits,
  valueSchemaFor,
  type FieldDefinition,
  type FieldType,
  type FieldValue,
} from './deps.js';
import {
  HIGH_BAND,
  MEDIUM_BAND,
  SNIPPET_MAX_CODE_POINTS,
  type ConfidenceBand,
  type FieldSuggestion,
  type InvalidReason,
} from './extraction.types.js';
import type { ExtractionPlan } from './extraction-schema.js';
import { cleanText, cutCodePoints, foldForMatch } from './text-clean.js';

export interface ModelFieldAnswer {
  value: unknown;
  confidence: unknown;
  sourceSnippet: unknown;
}

const SINGLE_LINE: ReadonlySet<FieldType> = new Set<FieldType>(['text', 'email', 'url', 'phone']);
const TEXT_LIKE: ReadonlySet<FieldType> = new Set<FieldType>(['text', 'textarea', 'email', 'url']);
const NUMERIC: ReadonlySet<FieldType> = new Set<FieldType>(['number', 'currency', 'percentage']);
const TWO_DECIMALS: ReadonlySet<FieldType> = new Set<FieldType>(['currency', 'percentage']);
const SINGLE_CHOICE: ReadonlySet<FieldType> = new Set<FieldType>(['select', 'radio']);
const MULTI_CHOICE: ReadonlySet<FieldType> = new Set<FieldType>(['multiselect', 'checkboxes']);

const NUMBER_TEXT = /^[+-]?\d+(\.\d+)?$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const TIME_TEXT = /^([01]\d|2[0-3]):[0-5]\d$/;
const OFFSET_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?([+-])(\d{2}):(\d{2})$/;

type Parsed =
  | { kind: 'value'; value: FieldValue; matchForms: string[] }
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: InvalidReason };

const empty = (): Parsed => ({ kind: 'empty' });
const invalid = (reason: InvalidReason): Parsed => ({ kind: 'invalid', reason });

function digitsOf(text: string): string {
  return text.replace(/[^0-9]/g, '');
}

const NUMBER_TOKEN = /\.?\d+(?:[.,٫٬]\d+)*/g;

function numberForm(writing: string): string {
  let form = writing.replace(/^[+-]/, '').replace(/[,٬]/g, '').replace(/٫/g, '.');
  if (form.includes('.')) form = form.replace(/0+$/, '').replace(/\.$/, '');
  return form.startsWith('0.') ? form.slice(1) : form;
}

function numberForms(...writings: string[]): string[] {
  const forms = new Set(writings.map(numberForm));
  forms.delete('');
  return [...forms];
}

function numberInSnippet(forms: string[], foldedSnippet: string): boolean {
  const tokens = new Set((foldedSnippet.match(NUMBER_TOKEN) ?? []).map(numberForm));
  return forms.some((form) => tokens.has(form));
}

function canonical(field: FieldDefinition, candidate: unknown): FieldValue | null {
  const result = valueSchemaFor(field).safeParse(candidate);
  return result.success ? result.data : null;
}

function tooLong(field: FieldDefinition, candidate: unknown): boolean {
  const result = valueSchemaFor(field).safeParse(candidate);
  return !result.success && result.error.issues.some((issue) => issue.code === 'too_big');
}

function parseText(field: FieldDefinition, raw: unknown): Parsed {
  if (typeof raw !== 'string') return invalid('TYPE');
  let text = cleanText(raw).trim();
  if (SINGLE_LINE.has(field.type)) text = text.replace(/\s+/g, ' ');
  if (field.type === 'phone') text = foldDigits(text);
  if (text === '') return empty();
  const value = canonical(field, text);
  if (value !== null) {
    return { kind: 'value', value, matchForms: field.type === 'phone' ? [digitsOf(text)] : [] };
  }
  if (tooLong(field, text)) return invalid('TOO_LONG');
  return invalid(field.type === 'text' || field.type === 'textarea' ? 'TYPE' : 'PATTERN');
}

function parseNumber(field: FieldDefinition, raw: unknown): Parsed {
  if (typeof raw !== 'string') return invalid('TYPE');
  const text = foldDigits(cleanText(raw)).trim();
  if (text === '') return empty();
  if (!NUMBER_TEXT.test(text)) return invalid('TYPE');
  const number = Number(text);
  if (!Number.isFinite(number)) return invalid('TYPE');
  const { min, max } = effectiveBounds(field);
  if ((min !== undefined && number < min) || (max !== undefined && number > max)) {
    return invalid('OUT_OF_RANGE');
  }
  if (TWO_DECIMALS.has(field.type) && Math.round(number * 100) / 100 !== number) {
    return invalid('DECIMALS');
  }
  const value = canonical(field, number);
  if (value === null) return invalid('OUT_OF_RANGE');
  return { kind: 'value', value, matchForms: numberForms(String(value), text) };
}

function parseDate(field: FieldDefinition, raw: unknown): Parsed {
  if (typeof raw !== 'string') return invalid('TYPE');
  const text = foldDigits(cleanText(raw)).trim();
  if (text === '') return empty();
  if (!DATE_TEXT.test(text)) return invalid('DATE_FORMAT');
  const value = canonical(field, text);
  return value === null ? invalid('DATE_FORMAT') : { kind: 'value', value, matchForms: [] };
}

export function toUtcInstant(text: string): string | null {
  if (text.endsWith('Z')) return canonicalInstant(text);
  const match = OFFSET_DATETIME.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms, sign, oh, om] = match;
  const parts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s ?? '0'),
    milli: Number((ms ?? '0').padEnd(3, '0')),
  };
  const offsetMinutes = Number(oh) * 60 + Number(om);
  if (Number(oh) > 14 || Number(om) > 59 || parts.hour > 23 || parts.minute > 59) return null;
  if (parts.second > 59) return null;
  const local = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.milli,
  );
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== parts.year ||
    check.getUTCMonth() !== parts.month - 1 ||
    check.getUTCDate() !== parts.day
  ) {
    return null;
  }
  const utc = local - (sign === '+' ? 1 : -1) * offsetMinutes * 60 * 1000;
  return canonicalInstant(new Date(utc).toISOString());
}

function parseDatetime(field: FieldDefinition, raw: unknown): Parsed {
  if (typeof raw !== 'string') return invalid('TYPE');
  const text = foldDigits(cleanText(raw)).trim();
  if (text === '') return empty();
  const instant = toUtcInstant(text);
  if (instant === null) return invalid('DATE_FORMAT');
  const value = canonical(field, instant);
  return value === null ? invalid('DATE_FORMAT') : { kind: 'value', value, matchForms: [] };
}

function parseTime(field: FieldDefinition, raw: unknown): Parsed {
  if (typeof raw !== 'string') return invalid('TYPE');
  const text = foldDigits(cleanText(raw)).trim();
  if (text === '') return empty();
  if (!TIME_TEXT.test(text)) return invalid('TIME_FORMAT');
  const value = canonical(field, text);
  return value === null ? invalid('TIME_FORMAT') : { kind: 'value', value, matchForms: [] };
}

function parseChoice(field: FieldDefinition, raw: unknown): Parsed {
  if (typeof raw !== 'string') return invalid('TYPE');
  const text = cleanText(raw).trim();
  if (text === '') return empty();
  const value = canonical(field, text);
  return value === null ? invalid('NOT_IN_OPTIONS') : { kind: 'value', value, matchForms: [] };
}

function parseMultiChoice(field: FieldDefinition, raw: unknown): Parsed {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return invalid('TYPE');
  const values = [...new Set((raw as string[]).map((item) => cleanText(item).trim()))].filter(
    (item) => item !== '',
  );
  if (values.length === 0) return empty();
  const value = canonical(field, values);
  return value === null ? invalid('NOT_IN_OPTIONS') : { kind: 'value', value, matchForms: [] };
}

export function parseByType(field: FieldDefinition, raw: unknown): Parsed {
  if (raw === null || raw === undefined) return empty();
  if (field.type === 'boolean') {
    return typeof raw === 'boolean'
      ? { kind: 'value', value: raw, matchForms: [] }
      : invalid('TYPE');
  }
  if (NUMERIC.has(field.type)) return parseNumber(field, raw);
  if (field.type === 'date') return parseDate(field, raw);
  if (field.type === 'datetime') return parseDatetime(field, raw);
  if (field.type === 'time') return parseTime(field, raw);
  if (SINGLE_CHOICE.has(field.type)) return parseChoice(field, raw);
  if (MULTI_CHOICE.has(field.type)) return parseMultiChoice(field, raw);
  return parseText(field, raw);
}

function snippetProblem(
  field: FieldDefinition,
  parsed: Extract<Parsed, { kind: 'value' }>,
  snippet: string,
  foldedText: string,
): InvalidReason | null {
  const foldedSnippet = foldForMatch(snippet);
  if (foldedSnippet === '' || !foldedText.includes(foldedSnippet)) return 'SNIPPET_NOT_FOUND';
  if (TEXT_LIKE.has(field.type)) {
    return foldedSnippet.includes(foldForMatch(String(parsed.value)))
      ? null
      : 'VALUE_NOT_IN_SNIPPET';
  }
  if (NUMERIC.has(field.type)) {
    return numberInSnippet(parsed.matchForms, foldedSnippet) ? null : 'VALUE_NOT_IN_SNIPPET';
  }
  if (field.type === 'phone') {
    const snippetDigits = digitsOf(foldedSnippet);
    const found = parsed.matchForms.some((form) => snippetDigits.includes(form));
    return found ? null : 'VALUE_NOT_IN_SNIPPET';
  }
  return null;
}

export function clampConfidence(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

export function bandOf(confidence: number): ConfidenceBand {
  if (confidence >= HIGH_BAND) return 'high';
  if (confidence >= MEDIUM_BAND) return 'medium';
  return 'low';
}

export function storedSnippet(snippet: string): string {
  return cutCodePoints(cleanText(snippet), SNIPPET_MAX_CODE_POINTS);
}

function suggestion(
  field: FieldDefinition,
  status: FieldSuggestion['status'],
  extra: Partial<FieldSuggestion> = {},
): FieldSuggestion {
  return {
    key: field.key,
    type: field.type,
    status,
    value: null,
    confidence: null,
    band: null,
    sourceSnippet: null,
    reason: null,
    ...extra,
  };
}

export function validateField(
  field: FieldDefinition,
  answer: unknown,
  foldedText: string,
): FieldSuggestion {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return suggestion(field, 'invalid', { reason: 'TYPE' });
  }
  const { value, confidence, sourceSnippet } = answer as ModelFieldAnswer;
  const parsed = parseByType(field, value);
  if (parsed.kind === 'empty') return suggestion(field, 'not_found');
  if (parsed.kind === 'invalid') return suggestion(field, 'invalid', { reason: parsed.reason });
  const snippet = typeof sourceSnippet === 'string' ? sourceSnippet : '';
  const problem = snippetProblem(field, parsed, snippet, foldedText);
  if (problem) return suggestion(field, 'invalid', { reason: problem });
  const clamped = clampConfidence(confidence);
  return suggestion(field, 'filled', {
    value: parsed.value,
    confidence: clamped,
    band: bandOf(clamped),
    sourceSnippet: storedSnippet(snippet),
  });
}

export function validateAnswer(
  typeFields: FieldDefinition[],
  plan: Pick<ExtractionPlan, 'sent' | 'skipped'>,
  output: Record<string, unknown>,
  sentText: string,
): FieldSuggestion[] {
  const foldedText = foldForMatch(sentText);
  const sent = new Map(plan.sent.map((field) => [field.key, field]));
  const skipped = new Map(plan.skipped.map((entry) => [entry.key, entry]));
  const result: FieldSuggestion[] = [];
  for (const field of typeFields) {
    const planned = sent.get(field.key);
    if (planned) {
      const answer = Object.hasOwn(output, field.key) ? output[field.key] : undefined;
      result.push(validateField(planned, answer, foldedText));
    } else {
      const entry = skipped.get(field.key);
      if (entry) result.push(entry);
    }
  }
  return result;
}
