import { z } from 'zod';
import { RELATION_KINDS } from './relation-kinds.js';

export const AddRelationSchema = z
  .object({
    kind: z.enum(RELATION_KINDS),
    otherId: z.string().min(1),
    direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
  })
  .strict();

export type AddRelationInput = z.infer<typeof AddRelationSchema>;
