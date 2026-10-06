import { z } from 'zod';
import { PageQuerySchema } from '../common/pagination.js';

function parseJsonField(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

const MetadataSchema = z.preprocess(
  parseJsonField,
  z.record(z.string(), z.unknown(), { error: 'Metadata must be a JSON object' }),
);

const NameSchema = z.string().trim().min(1).max(200);
const CommentSchema = z.string().trim().max(500);

export const TagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(
    /^[a-z0-9][a-z0-9 _-]*$/,
    'Tags may contain letters, digits, spaces, dashes and underscores',
  );

export const TagsSchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value.trim().startsWith('[')
        ? parseJsonField(value)
        : value.split(',').filter((part) => part.trim() !== '')
      : value,
  z
    .array(TagSchema)
    .max(20, 'At most 20 tags')
    .transform((tags) => [...new Set(tags)].sort()),
);

export const CreateRecordSchema = z
  .object({
    name: NameSchema,
    contentTypeId: z.string().min(1),
    folderId: z.string().min(1),
    metadata: MetadataSchema.default({}),
    comment: CommentSchema.default(''),
    tags: TagsSchema.default([]),
  })
  .strict();

export const SetTagsSchema = z.object({ tags: TagsSchema }).strict();

export const NewVersionSchema = z
  .object({ metadata: MetadataSchema.optional(), comment: CommentSchema.default('') })
  .strict();

export const RenameRecordSchema = z.object({ name: NameSchema }).strict();
export const MoveRecordSchema = z.object({ folderId: z.string().min(1) }).strict();
export const RestoreVersionSchema = z.object({ comment: CommentSchema.optional() }).strict();

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    const c0 = unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d;
    if (c0 || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}

export const CONTROL_CHARACTER_MESSAGE = 'Must not contain control characters';

export const SearchTextSchema = z
  .string()
  .trim()
  .max(200)
  .refine((value) => !hasControlCharacter(value), CONTROL_CHARACTER_MESSAGE);

const MAX_META_FILTER_LENGTH = 200;

export const META_PREFIX = 'meta.';

export const ListRecordsQuerySchema = PageQuerySchema.extend({
  q: SearchTextSchema.optional(),
  contentTypeId: z.string().min(1).optional(),
  folderId: z.string().min(1).optional(),
  tag: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag !== ''),
    ),
  includeSubfolders: flag('false'),
  dateField: z.enum(['createdAt', 'updatedAt']).default('updatedAt'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})
  .loose()
  .superRefine((query, ctx) => {
    for (const [key, value] of Object.entries(query)) {
      if (!key.startsWith(META_PREFIX)) continue;
      const values: unknown[] = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item !== 'string') continue;
        if (hasControlCharacter(item)) {
          ctx.addIssue({ code: 'custom', path: [key], message: CONTROL_CHARACTER_MESSAGE });
        } else if (item.trim().length > MAX_META_FILTER_LENGTH) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `At most ${MAX_META_FILTER_LENGTH} characters`,
          });
        }
      }
    }
  });

export const DownloadQuerySchema = z.object({
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
});

export type CreateRecordInput = z.infer<typeof CreateRecordSchema>;
export type NewVersionInput = z.infer<typeof NewVersionSchema>;
export type RenameRecordInput = z.infer<typeof RenameRecordSchema>;
export type MoveRecordInput = z.infer<typeof MoveRecordSchema>;
export type SetTagsInput = z.infer<typeof SetTagsSchema>;
export type RestoreVersionInput = z.infer<typeof RestoreVersionSchema>;
export type ListRecordsQuery = z.infer<typeof ListRecordsQuerySchema>;
export type DownloadQuery = z.infer<typeof DownloadQuerySchema>;

export function metadataFiltersOf(query: Record<string, unknown>): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith(META_PREFIX) && typeof value === 'string' && value.trim() !== '') {
      filters[key.slice(META_PREFIX.length)] = value.trim();
    }
  }
  return filters;
}
