import { z } from 'zod';
import type { FieldDefinition, FieldType } from './deps.js';
import { MAX_FIELDS_CEILING, type FieldSuggestion, type SkipReason } from './extraction.types.js';

const VALUE_SCHEMAS: Record<FieldType, (() => z.ZodType) | null> = {
  text: () => z.string().nullable(),
  textarea: () => z.string().nullable(),
  email: () => z.string().nullable(),
  url: () => z.string().nullable(),
  phone: () => z.string().nullable(),
  number: () => z.string().nullable(),
  currency: () => z.string().nullable(),
  percentage: () => z.string().nullable(),
  date: () => z.string().nullable(),
  datetime: () => z.string().nullable(),
  time: () => z.string().nullable(),
  boolean: () => z.boolean().nullable(),
  select: () => z.string().nullable(),
  radio: () => z.string().nullable(),
  multiselect: () => z.array(z.string()).nullable(),
  checkboxes: () => z.array(z.string()).nullable(),
  user: null,
};

export function isFillable(field: FieldDefinition): boolean {
  return VALUE_SCHEMAS[field.type] !== null;
}

export interface ExtractionPlan {
  sent: FieldDefinition[];
  skipped: FieldSuggestion[];
  schema: z.ZodObject;
}

function skippedSuggestion(field: FieldDefinition, reason: SkipReason): FieldSuggestion {
  return {
    key: field.key,
    type: field.type,
    status: 'skipped',
    value: null,
    confidence: null,
    band: null,
    sourceSnippet: null,
    reason,
  };
}

export function planExtraction(fields: FieldDefinition[], maxFields: number): ExtractionPlan {
  const cap = Math.max(0, Math.min(maxFields, MAX_FIELDS_CEILING));
  const sent: FieldDefinition[] = [];
  const skipped: FieldSuggestion[] = [];
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const value = VALUE_SCHEMAS[field.type];
    if (!value) {
      skipped.push(skippedSuggestion(field, 'USER_FIELD'));
      continue;
    }
    if (sent.length >= cap) {
      skipped.push(skippedSuggestion(field, 'FIELD_LIMIT'));
      continue;
    }
    sent.push(field);
    shape[field.key] = z
      .object({ value: value(), confidence: z.number(), sourceSnippet: z.string().nullable() })
      .strict();
  }
  return { sent, skipped, schema: z.object(shape).strict() };
}
