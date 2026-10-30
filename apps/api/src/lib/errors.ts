import type { ApiMessageKey } from '@ordo/shared';
import type { ZodError, ZodType, z } from 'zod';

export class HttpError extends Error {
  messageKey?: ApiMessageKey;
  params?: Record<string, string | number>;

  constructor(
    public statusCode: number,
    message: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(message);
  }

  /** Marks a message the web app translates (`API_MESSAGE_KEYS`); `params` fill its placeholders. */
  as(key: ApiMessageKey, params?: Record<string, string | number>) {
    this.messageKey = key;
    this.params = params;
    return this;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, 'bad_request', details);
export const unauthorized = (message?: string) => {
  const err = new HttpError(401, message ?? 'Not signed in', 'unauthorized');
  return message ? err : err.as('not_signed_in');
};
export const forbidden = (message?: string) => {
  const err = new HttpError(403, message ?? 'You do not have access to this', 'forbidden');
  return message ? err : err.as('no_access');
};
export const notFound = (what = 'Resource') =>
  new HttpError(404, `${what} not found`, 'not_found').as('not_found');
export const conflict = (message: string) => new HttpError(409, message, 'conflict');

export function parse<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw validationError(result.error);
  return result.data;
}

/** parse() for routes that answer bad input their own way (a redirect, a 404, a closed socket). */
export function tryParse<S extends ZodType>(schema: S, data: unknown): z.infer<S> | null {
  const result = schema.safeParse(data ?? {});
  return result.success ? result.data : null;
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
