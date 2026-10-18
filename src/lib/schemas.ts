import { z } from 'zod';

export const roleSchema = z.enum(['organizer', 'customer']);
export type Role = z.infer<typeof roleSchema>;

export const idParams = z.object({ id: z.uuid() });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type Pagination = z.infer<typeof paginationQuery>;

export const pageInfo = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  hasMore: z.boolean(),
});

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 503;

export function errors<const T extends ErrorStatus[]>(...statuses: T): Record<T[number], typeof errorResponse> {
  return Object.fromEntries(statuses.map((s) => [s, errorResponse])) as Record<T[number], typeof errorResponse>;
}

/**
 * Pages are fetched with one extra row so `hasMore` is known without a COUNT(*) query.
 */
export function toPage<T>(rows: T[], { limit, offset }: Pagination) {
  return { data: rows.slice(0, limit), page: { limit, offset, hasMore: rows.length > limit } };
}
