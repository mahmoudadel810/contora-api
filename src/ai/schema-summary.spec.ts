import { describe, expect, it } from 'vitest';
import type { ContentTypeView } from '../content-types/content-type.schema.js';
import { SCHEMA_SUMMARY_CHARS, schemaSummaryOf } from './schema-summary.js';

function typeOf(name: string, fields: ContentTypeView['fields'], n = 0): ContentTypeView {
  return {
    id: n.toString(16).padStart(24, '0'),
    name,
    description: '',
    fields,
    schemaVersion: 1,
    status: 'active',
    aiExtraction: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('schemaSummaryOf', () => {
  it('lists each type with its fields, options capped at 10 plus a count', () => {
    const summary = schemaSummaryOf([
      typeOf('Invoice', [
        { key: 'amount', label: 'Amount', type: 'number', required: true, min: 0 },
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          required: false,
          options: Array.from({ length: 12 }, (_, i) => `o${i}`),
        },
      ]),
    ]);
    const parsed = JSON.parse(summary) as { types: Array<Record<string, unknown>> };
    expect(parsed.types).toEqual([
      {
        id: '0'.repeat(24),
        name: 'Invoice',
        fields: [
          { key: 'amount', label: 'Amount', type: 'number', required: true, min: 0 },
          {
            key: 'status',
            label: 'Status',
            type: 'select',
            required: false,
            options: ['o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9', '+2'],
          },
        ],
      },
    ]);
  });

  it('falls back to names only past the cap, and stays under it', () => {
    const many = Array.from({ length: 60 }, (_, n) =>
      typeOf(
        `Type ${n}`,
        Array.from({ length: 8 }, (_, f) => ({
          key: `field${f}`,
          label: `A fairly long field label ${f}`,
          type: 'text' as const,
          required: false,
        })),
        n,
      ),
    );
    const summary = schemaSummaryOf(many);
    expect(summary.length).toBeLessThanOrEqual(SCHEMA_SUMMARY_CHARS);
    const parsed = JSON.parse(summary) as { types: Array<Record<string, unknown>>; note: string };
    expect(parsed.types[0]).toEqual({ id: '0'.repeat(24), name: 'Type 0' });
    expect(parsed.note).toMatch(/schema_get_content_type/);
  });

  it('says so when there is no active type', () => {
    expect(JSON.parse(schemaSummaryOf([]))).toEqual({ types: [] });
  });
});
