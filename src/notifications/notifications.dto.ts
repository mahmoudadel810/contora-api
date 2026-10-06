import { z } from 'zod';

export const NotificationListQuerySchema = z
  .object({
    unread: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;
