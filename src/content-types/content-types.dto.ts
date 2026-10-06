import { z } from 'zod';
import { CONTENT_TYPE_STATUSES } from './content-type.schema.js';
import { FieldDefinitionSchema } from './field-types.js';

export const ContentTypeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    fields: z.array(FieldDefinitionSchema).max(50),
    aiExtraction: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.fields.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: `Duplicate field key "${field.key}"`,
        });
      }
      seen.add(field.key);
    });
  });

export const ContentTypeListQuerySchema = z.object({
  status: z.enum([...CONTENT_TYPE_STATUSES, 'all']).default('all'),
});

export type ContentTypeBody = z.infer<typeof ContentTypeBodySchema>;
export type ContentTypeListQuery = z.infer<typeof ContentTypeListQuerySchema>;
