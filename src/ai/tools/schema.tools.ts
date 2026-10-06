import { z } from 'zod';
import type { ContentTypeView } from '../../content-types/content-type.schema.js';
import { notice } from '../blocks.js';
import { contentTypeLink } from '../links.js';
import { MODEL_ROWS, objectId } from './search.tools.js';
import { defineTool, type ToolDef } from './tool.js';

export function fieldSummary(field: ContentTypeView['fields'][number]) {
  const options = field.options ?? [];
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(options.length > 0
      ? {
          options:
            options.length > 10 ? [...options.slice(0, 10), `+${options.length - 10}`] : options,
        }
      : {}),
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    ...('currency' in field && typeof field.currency === 'string'
      ? { currency: field.currency }
      : {}),
  };
}

const schemaListContentTypes = defineTool({
  name: 'schema_list_content_types',
  domain: 'schema',
  description: 'The content types (metadata schemas): active, archived or all.',
  input: z.object({ status: z.enum(['active', 'archived', 'all']).nullable() }).strict(),
  async run(ctx, input) {
    const types = await ctx.services.contentTypes.list(ctx.principal, {
      status: input.status ?? 'active',
    });
    return {
      data: {
        total: types.length,
        truncated: types.length > MODEL_ROWS,
        items: types.slice(0, MODEL_ROWS).map((type) => ({
          id: type.id,
          name: type.name,
          status: type.status,
          fields: type.fields.length,
        })),
      },
      blocks:
        types.length === 0
          ? [notice('There are no content types here yet.')]
          : [
              {
                kind: 'table',
                title: 'Content types',
                columns: ['Name', 'Status', 'Fields'],
                rows: types.map((type) => [type.name, type.status, String(type.fields.length)]),
                truncated: false,
              },
            ],
    };
  },
});

const schemaGetContentType = defineTool({
  name: 'schema_get_content_type',
  domain: 'schema',
  description: 'One content type with every field: key, label, type, required and constraints.',
  input: z.object({ id: objectId }).strict(),
  async run(ctx, input) {
    const type = await ctx.services.contentTypes.get(ctx.principal, input.id);
    return {
      data: {
        id: type.id,
        name: type.name,
        description: type.description,
        status: type.status,
        schemaVersion: type.schemaVersion,
        fields: type.fields.map(fieldSummary),
      },
      blocks: [
        {
          kind: 'contentType',
          contentType: {
            id: type.id,
            name: type.name,
            status: type.status,
            fields: type.fields.map(({ key, label, type: fieldType, required }) => ({
              key,
              label,
              type: fieldType,
              required,
            })),
            link: contentTypeLink(type.id),
          },
        },
      ],
    };
  },
});

export const SCHEMA_TOOLS: ToolDef[] = [schemaListContentTypes, schemaGetContentType] as ToolDef[];
