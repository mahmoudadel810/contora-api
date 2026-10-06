import type { FieldType, FieldValue } from './deps.js';

export const EXTRACTION_STATUSES = [
  'queued',
  'processing',
  'ready',
  'failed',
  'confirmed',
  'discarded',
  'expired',
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const IN_FLIGHT_STATUSES: readonly ExtractionStatus[] = ['queued', 'processing'];
export const OPEN_STATUSES: readonly ExtractionStatus[] = [
  'queued',
  'processing',
  'ready',
  'failed',
];
export const TERMINAL_STATUSES: readonly ExtractionStatus[] = ['confirmed', 'discarded', 'expired'];

export type ExtractionStage = 'text' | 'fields' | null;

export const FILE_KINDS = ['pdf', 'zip', 'text'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const TEXT_SOURCES = ['pdf_text', 'docx', 'plain'] as const;
export type TextSource = (typeof TEXT_SOURCES)[number];

export const EXTRACTION_ERROR_CODES = [
  'UNSUPPORTED_FILE',
  'EXTRACTION_TIMEOUT',
  'AI_UNAVAILABLE',
  'AI_DISABLED',
  'AI_DISABLED_FOR_TENANT',
  'EXTRACTION_INTERRUPTED',
] as const;
export type ExtractionErrorCode = (typeof EXTRACTION_ERROR_CODES)[number];

export const EXTRACTION_ERROR_REASONS = [
  'no_text',
  'type',
  'text',
  'model',
  'provider',
  'content_filter',
  'bad_output',
  'restart',
  'confirm',
  'not_configured',
] as const;
export type ExtractionErrorReason = (typeof EXTRACTION_ERROR_REASONS)[number];

export type InvalidReason =
  | 'TYPE'
  | 'NOT_IN_OPTIONS'
  | 'OUT_OF_RANGE'
  | 'DATE_FORMAT'
  | 'TIME_FORMAT'
  | 'DECIMALS'
  | 'TOO_LONG'
  | 'PATTERN'
  | 'SNIPPET_NOT_FOUND'
  | 'VALUE_NOT_IN_SNIPPET';
export type SkipReason = 'USER_FIELD' | 'FIELD_LIMIT';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface FieldSuggestion {
  key: string;
  type: FieldType;
  status: 'filled' | 'not_found' | 'invalid' | 'skipped';
  value: FieldValue | null;
  confidence: number | null;
  band: ConfidenceBand | null;
  sourceSnippet: string | null;
  reason: InvalidReason | SkipReason | null;
}

export type ReviewOutcome = 'accepted' | 'edited' | 'cleared' | 'manual' | 'empty';

export interface FieldReview {
  key: string;
  type: FieldType;
  suggestedStatus: FieldSuggestion['status'] | 'none';
  band: ConfidenceBand | null;
  suggested: FieldValue | null;
  final: FieldValue | null;
  outcome: ReviewOutcome;
}

export const HIGH_BAND = 0.85;
export const MEDIUM_BAND = 0.6;

export const SNIPPET_MAX_CODE_POINTS = 120;

export const MAX_FIELDS_CEILING = 24;
