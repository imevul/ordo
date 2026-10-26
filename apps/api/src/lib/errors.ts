import type { ZodError, ZodType, z } from 'zod';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, 'bad_request', details);
export const unauthorized = (message = 'Not signed in') =>
  new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'You do not have access to this') =>
  new HttpError(403, message, 'forbidden');
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'not_found');
export const conflict = (message: string) => new HttpError(409, message, 'conflict');

export function parse<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function validationError(error: ZodError) {
  const first = error.issues[0];
  const where = first?.path.length ? `${first.path.join('.')}: ` : '';
  return badRequest(`${where}${first?.message ?? 'Invalid input'}`, error.issues);
}

/** Postgres unique-violation → 409. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
