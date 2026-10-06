import { z } from 'zod';

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function toPage<T>(items: T[], total: number, query: PageQuery): Page<T> {
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export function skipOf(query: PageQuery): number {
  return (query.page - 1) * query.pageSize;
}
