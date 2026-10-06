import type { FieldDefinition } from '../content-types/field-types.js';

export function fieldsToAppend(
  typeName: string,
  existing: readonly Pick<FieldDefinition, 'key'>[],
  demo: readonly FieldDefinition[],
): FieldDefinition[] {
  const missing = demo.filter((field) => !existing.some((e) => e.key === field.key));
  const required = missing.filter((field) => field.required);
  if (required.length > 0) {
    throw new Error(
      `Cannot add the required field(s) ${required.map((f) => f.key).join(', ')} to the existing ` +
        `content type "${typeName}"; add them by hand or make them optional in the demo data`,
    );
  }
  return missing;
}
