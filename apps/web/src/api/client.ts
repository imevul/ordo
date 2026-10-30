import { API_MESSAGE_KEYS, type ApiMessageKey } from '@ordo/shared';
import { getLocale, t } from '../i18n/index.ts';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

interface ErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
  messageKey?: string;
  params?: Record<string, string | number>;
}

const isMessageKey = (k: unknown): k is ApiMessageKey =>
  (API_MESSAGE_KEYS as readonly unknown[]).includes(k);

/**
 * What to tell someone about a failed request. Keyed API errors are shown in their language; in
 * English the API's own message is kept, since it can be more specific than the catalogue's.
 */
export function errorMessage(status: number, data: ErrorBody | null, statusText = ''): string {
  // A plain rate limit; a keyed 429 (an account lockout) says more below.
  if (status === 429 && !isMessageKey(data?.messageKey)) return t('errors.rateLimited');
  if (status >= 500 && (!data?.message || data.error === 'error')) return t('errors.server');
  if (getLocale() !== 'en' && isMessageKey(data?.messageKey))
    return t(`errors.api.${data.messageKey}`, data.params);
  return data?.message || statusText || t('errors.server');
}

async function send(path: string, init: RequestInit): Promise<{ res: Response; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, t('errors.network'), 'network');
  }
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy's HTML error page, say; the status still tells what happened.
  }
  if (!res.ok) {
    const body = data as ErrorBody | null;
    throw new ApiError(
      res.status,
      errorMessage(res.status, body, res.statusText),
      body?.error,
      body?.details,
    );
  }
  return { res, data };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { data } = await send(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Multipart upload (the one non-JSON request). */
export async function upload<T>(path: string, file: Blob, filename: string): Promise<T> {
  const form = new FormData();
  form.append('file', file, filename);
  const { data } = await send(path, { method: 'POST', body: form });
  return data as T;
}

/** Shorthand for workspace-scoped paths. */
export const wsPath = (slug: string, path: string) => `/w/${encodeURIComponent(slug)}${path}`;
