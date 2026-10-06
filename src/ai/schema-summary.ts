import type { ContentTypeView } from '../content-types/content-type.schema.js';
import { fieldSummary } from './tools/schema.tools.js';

export const SCHEMA_SUMMARY_CHARS = 6000;

const NAMES_ONLY_NOTE =
  'Only names are listed; call schema_get_content_type (schema domain) for fields.';

export function schemaSummaryOf(types: ContentTypeView[]): string {
  const full = JSON.stringify({
    types: types.map((type) => ({
      id: type.id,
      name: type.name,
      fields: type.fields.map(fieldSummary),
    })),
  });
  if (full.length <= SCHEMA_SUMMARY_CHARS) return full;

  const names = types.map((type) => ({ id: type.id, name: type.name }));
  for (let count = names.length; count >= 0; count -= 1) {
    const omitted = names.length - count;
    const summary = JSON.stringify({
      types: names.slice(0, count),
      note:
        omitted > 0 ? `${NAMES_ONLY_NOTE} ${omitted} more types are not listed.` : NAMES_ONLY_NOTE,
    });
    if (summary.length <= SCHEMA_SUMMARY_CHARS) return summary;
  }
  return JSON.stringify({ types: [], note: NAMES_ONLY_NOTE });
}
