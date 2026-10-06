import type { FieldDefinition } from './deps.js';
import type { FieldSuggestion } from './extraction.types.js';
import { computeReview, reviewCounts, sameValue, withoutSnippets } from './extraction-outcomes.js';

const FIELDS: FieldDefinition[] = [
  { key: 'supplier', label: 'Supplier', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: true },
  { key: 'dueDate', label: 'Due', type: 'date', required: false },
  { key: 'status', label: 'Status', type: 'select', required: false, options: ['Open', 'Paid'] },
  { key: 'tags', label: 'Tags', type: 'multiselect', required: false, options: ['A', 'B', 'C'] },
  { key: 'notes', label: 'Notes', type: 'textarea', required: false },
];

const filled = (key: string, type: FieldDefinition['type'], value: FieldSuggestion['value']) =>
  ({
    key,
    type,
    status: 'filled',
    value,
    confidence: 0.9,
    band: 'high',
    sourceSnippet: 'snippet',
    reason: null,
  }) as FieldSuggestion;

const SUGGESTIONS: FieldSuggestion[] = [
  filled('supplier', 'text', 'Acme'),
  filled('amount', 'number', 120.5),
  { ...filled('dueDate', 'date', '2026-03-01'), band: 'low', confidence: 0.4 },
  {
    key: 'status',
    type: 'select',
    status: 'not_found',
    value: null,
    confidence: null,
    band: null,
    sourceSnippet: null,
    reason: null,
  },
  filled('tags', 'multiselect', ['A', 'B']),
  {
    key: 'notes',
    type: 'textarea',
    status: 'invalid',
    value: null,
    confidence: null,
    band: null,
    sourceSnippet: null,
    reason: 'SNIPPET_NOT_FOUND',
  },
];

describe('computeReview', () => {
  it('computes accepted, edited, cleared, manual and empty on the server', () => {
    const review = computeReview(FIELDS, SUGGESTIONS, {
      supplier: 'Acme',
      amount: 99,
      status: 'Paid',
      tags: ['B', 'A'],
    });
    expect(review.map((r) => [r.key, r.outcome])).toEqual([
      ['supplier', 'accepted'],
      ['amount', 'edited'],
      ['dueDate', 'cleared'],
      ['status', 'manual'],
      ['tags', 'accepted'],
      ['notes', 'empty'],
    ]);
    expect(review[0]).toEqual({
      key: 'supplier',
      type: 'text',
      suggestedStatus: 'filled',
      band: 'high',
      suggested: 'Acme',
      final: 'Acme',
      outcome: 'accepted',
    });
    expect(review[5]).toMatchObject({ suggestedStatus: 'invalid', suggested: null, final: null });
  });

  it("gives manual and empty with suggestedStatus 'none' when the job was not ready", () => {
    const review = computeReview(FIELDS, null, { supplier: 'Typed', amount: 5 });
    expect(review.map((r) => [r.suggestedStatus, r.outcome])).toEqual([
      ['none', 'manual'],
      ['none', 'manual'],
      ['none', 'empty'],
      ['none', 'empty'],
      ['none', 'empty'],
      ['none', 'empty'],
    ]);
  });

  it('counts outcomes and suggestion statuses for the audit entry', () => {
    const review = computeReview(FIELDS, SUGGESTIONS, { supplier: 'Acme', amount: 99 });
    expect(reviewCounts(review, SUGGESTIONS)).toEqual({
      accepted: 1,
      edited: 1,
      cleared: 2,
      manual: 0,
      empty: 2,
      invalid: 1,
      notFound: 1,
      skipped: 0,
    });
  });

  it('compares multi-choice values as sets and everything else strictly', () => {
    expect(sameValue(['A', 'B'], ['B', 'A'])).toBe(true);
    expect(sameValue(['A'], ['A', 'B'])).toBe(false);
    expect(sameValue(120.5, 120.5)).toBe(true);
    expect(sameValue('120.5', 120.5)).toBe(false);
  });

  it('nulls snippets and keeps statuses and values', () => {
    const cleared = withoutSnippets(SUGGESTIONS);
    expect(cleared?.every((entry) => entry.sourceSnippet === null)).toBe(true);
    expect(cleared?.[0]?.value).toBe('Acme');
    expect(withoutSnippets(null)).toBeNull();
  });
});
