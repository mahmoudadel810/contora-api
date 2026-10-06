import type { FieldDefinition, FieldValue } from './deps.js';
import type { FieldReview, FieldSuggestion, ReviewOutcome } from './extraction.types.js';

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const left = new Set(a.map(String));
    const right = new Set(b.map(String));
    return left.size === right.size && [...left].every((item) => right.has(item));
  }
  return a === b;
}

function outcomeOf(suggested: FieldValue | null, final: unknown): ReviewOutcome {
  if (suggested !== null) {
    if (isEmpty(final)) return 'cleared';
    return sameValue(suggested, final) ? 'accepted' : 'edited';
  }
  return isEmpty(final) ? 'empty' : 'manual';
}

function asFieldValue(value: unknown): FieldValue | null {
  if (isEmpty(value)) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  ) {
    return value as FieldValue;
  }
  return null;
}

export function computeReview(
  typeFields: FieldDefinition[],
  suggestions: FieldSuggestion[] | null,
  finalMetadata: Record<string, unknown>,
): FieldReview[] {
  const byKey = new Map((suggestions ?? []).map((entry) => [entry.key, entry]));
  return typeFields.map((field) => {
    const entry = suggestions ? byKey.get(field.key) : undefined;
    const suggested = entry?.status === 'filled' ? entry.value : null;
    const final = Object.hasOwn(finalMetadata, field.key) ? finalMetadata[field.key] : undefined;
    return {
      key: field.key,
      type: field.type,
      suggestedStatus: suggestions === null ? 'none' : (entry?.status ?? 'none'),
      band: entry?.status === 'filled' ? entry.band : null,
      suggested,
      final: asFieldValue(final),
      outcome: outcomeOf(suggested, final),
    };
  });
}

export interface ReviewCounts {
  accepted: number;
  edited: number;
  cleared: number;
  manual: number;
  empty: number;
  invalid: number;
  notFound: number;
  skipped: number;
}

export function reviewCounts(
  review: FieldReview[],
  suggestions: FieldSuggestion[] | null,
): ReviewCounts {
  const counts: ReviewCounts = {
    accepted: 0,
    edited: 0,
    cleared: 0,
    manual: 0,
    empty: 0,
    invalid: 0,
    notFound: 0,
    skipped: 0,
  };
  for (const entry of review) counts[entry.outcome] += 1;
  for (const entry of suggestions ?? []) {
    if (entry.status === 'invalid') counts.invalid += 1;
    else if (entry.status === 'not_found') counts.notFound += 1;
    else if (entry.status === 'skipped') counts.skipped += 1;
  }
  return counts;
}

export function withoutSnippets(suggestions: FieldSuggestion[] | null): FieldSuggestion[] | null {
  return suggestions ? suggestions.map((entry) => ({ ...entry, sourceSnippet: null })) : null;
}
