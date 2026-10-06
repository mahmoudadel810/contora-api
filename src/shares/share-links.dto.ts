import { z } from 'zod';
import { PageQuerySchema } from '../common/pagination.js';

export const MAX_PASSWORD_BYTES = 72;

export const SharePasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES, {
    message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes`,
  });

export const CreateShareLinkSchema = z
  .object({
    expiresAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    password: SharePasswordSchema.optional(),
  })
  .strict();

export const RecordShareLinksQuerySchema = PageQuerySchema.strict();

export const ListShareLinksQuerySchema = PageQuerySchema.extend({
  status: z.enum(['active', 'all']).default('active'),
}).strict();

export const UnlockSchema = z
  .object({
    password: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES, {
        message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes`,
      }),
  })
  .strict();

export const ContentQuerySchema = z
  .object({ disposition: z.enum(['attachment', 'inline']).default('attachment') })
  .strict();

export type UnlockInput = z.infer<typeof UnlockSchema>;
export type ContentQuery = z.infer<typeof ContentQuerySchema>;
export type CreateShareLinkInput = z.infer<typeof CreateShareLinkSchema>;
export type RecordShareLinksQuery = z.infer<typeof RecordShareLinksQuerySchema>;
export type ListShareLinksQuery = z.infer<typeof ListShareLinksQuerySchema>;

export const NoQuerySchema = z.object({}).strict();
