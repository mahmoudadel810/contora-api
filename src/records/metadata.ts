import { errors } from '../common/errors.js';
import { issuesOf } from '../common/zod.pipe.js';
import {
  buildMetadataSchema,
  metadataSearchText,
  type FieldDefinition,
} from '../content-types/field-types.js';

export function validateMetadata(
  fields: FieldDefinition[],
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const result = buildMetadataSchema(fields).safeParse(metadata);
  if (!result.success) {
    throw errors.validation(
      issuesOf(result.error).map((issue) => ({
        ...issue,
        path: issue.path === '' ? 'metadata' : `metadata.${issue.path}`,
      })),
    );
  }
  return result.data;
}

export function searchTextOf(
  name: string,
  fields: FieldDefinition[],
  metadata: Record<string, unknown>,
  fileName: string | null,
  tags: string[] = [],
): string {
  return [name.trim(), metadataSearchText(fields, metadata), fileName ?? '', ...tags]
    .filter((part) => part !== '')
    .join(' ')
    .toLowerCase();
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
