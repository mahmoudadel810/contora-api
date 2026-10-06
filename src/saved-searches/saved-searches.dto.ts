import { z } from 'zod';
import {
  CONTROL_CHARACTER_MESSAGE,
  hasControlCharacter,
  SearchTextSchema,
  TagSchema,
} from '../records/records.dto.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Expected an id');

export const SearchCriteriaSchema = z
  .object({
    q: SearchTextSchema.optional(),
    contentTypeId: objectId.optional(),
    metaKey: z.string().max(60).optional(),
    metaValue: z
      .string()
      .max(200)
      .refine((value) => !hasControlCharacter(value), CONTROL_CHARACTER_MESSAGE)
      .optional(),
    folder: z
      .object({ id: objectId, path: z.string().max(500) })
      .strict()
      .optional(),
    includeSubfolders: z.boolean().optional(),
    dateField: z.enum(['createdAt', 'updatedAt']).optional(),
    from: day.optional(),
    to: day.optional(),
    tags: z.array(TagSchema).max(20).optional(),
  })
  .strict()
  .refine((c) => !c.from || !c.to || c.from <= c.to, {
    path: ['to'],
    message: '"to" must not be before "from"',
  });

export const CreateSavedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    criteria: SearchCriteriaSchema,
  })
  .strict();

export type SearchCriteria = z.infer<typeof SearchCriteriaSchema>;
export type CreateSavedSearchInput = z.infer<typeof CreateSavedSearchSchema>;
