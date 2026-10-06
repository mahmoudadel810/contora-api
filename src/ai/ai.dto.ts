import { z } from 'zod';
import { PageQuerySchema } from '../common/pagination.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Expected an id');

export const MESSAGE_CHARS_CEILING = 20000;
export const MAX_SELECTED_RECORDS = 20;

export const ASSISTANT_PAGES = [
  'dashboard',
  'repository',
  'record',
  'search',
  'my-records',
  'trash',
  'content-types',
  'content-type',
  'audit',
  'admin',
  'members',
  'other',
] as const;

export const AssistantContextSchema = z
  .object({
    page: z.enum(ASSISTANT_PAGES),
    recordId: objectId.nullable(),
    folderId: objectId.nullable(),
    contentTypeId: objectId.nullable(),
    search: z
      .object({
        q: z.string().trim().max(200).nullable(),
        tag: z.string().trim().max(200).nullable(),
      })
      .strict()
      .nullable(),
    selectedRecordIds: z.array(objectId).max(MAX_SELECTED_RECORDS),
  })
  .strict();

export const ChatBodySchema = z
  .object({
    sessionId: objectId.nullable(),
    message: z.string().trim().min(1).max(MESSAGE_CHARS_CEILING),
    mode: z.enum(['send', 'regenerate']).default('send'),
    context: AssistantContextSchema,
  })
  .strict();

export const SessionsQuerySchema = PageQuerySchema.strict();

export const RenameSessionSchema = z.object({ title: z.string().trim().min(1).max(80) }).strict();

export const ConfirmBodySchema = z
  .object({
    acknowledgeDestructive: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((value) => value === true || value === 'true'),
  })
  .strict();

export type AssistantContext = z.infer<typeof AssistantContextSchema>;
export type ChatBody = z.infer<typeof ChatBodySchema>;
export type SessionsQuery = z.infer<typeof SessionsQuerySchema>;
export type RenameSessionInput = z.infer<typeof RenameSessionSchema>;
export type ConfirmBody = z.infer<typeof ConfirmBodySchema>;
