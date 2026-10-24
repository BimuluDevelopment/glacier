import { z } from 'zod';

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const uuidParam = z.object({ id: z.uuid() });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
});

export function paginate(query: { page: number; perPage: number }) {
  return { skip: (query.page - 1) * query.perPage, take: query.perPage };
}

export function paged<T>(data: T[], total: number, query: { page: number; perPage: number }) {
  return { data, meta: { page: query.page, perPage: query.perPage, total, pages: Math.max(1, Math.ceil(total / query.perPage)) } };
}
