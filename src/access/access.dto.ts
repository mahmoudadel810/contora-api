import { z } from 'zod';
import { ACCESS_LEVELS, GRANT_TARGET_TYPES } from './access-scope.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Expected an id');

export const GrantListQuerySchema = z
  .object({
    userId: objectId.optional(),
    targetType: z.enum(GRANT_TARGET_TYPES).optional(),
    targetId: objectId.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    const byTarget = query.targetType !== undefined || query.targetId !== undefined;
    if (query.userId !== undefined && byTarget) {
      ctx.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'Use userId or a target, not both',
      });
    } else if (query.userId === undefined && !byTarget) {
      ctx.addIssue({ code: 'custom', path: ['userId'], message: 'Give userId or a target' });
    } else if (byTarget && query.targetType === undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetType'], message: 'Required with targetId' });
    } else if (byTarget && query.targetId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetId'], message: 'Required with targetType' });
    }
  });

export const PutGrantSchema = z
  .object({
    userId: objectId,
    targetType: z.enum(GRANT_TARGET_TYPES),
    targetId: objectId,
    level: z.enum(ACCESS_LEVELS),
  })
  .strict();

export type GrantListQuery = z.infer<typeof GrantListQuerySchema>;
export type PutGrantInput = z.infer<typeof PutGrantSchema>;
