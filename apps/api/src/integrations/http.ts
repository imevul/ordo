import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { safeFetch } from '../lib/safeFetch.ts';

export class ApiCallError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON over `safeFetch`, for the APIs integrations talk to. Non-2xx responses throw with the API's message. */
export async function callApi<T = unknown>(
  app: FastifyInstance,
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    /** For long polls; defaults to 15 s. */
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const res = await safeFetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': `Ordo/${app.env.version}`,
      ...(opts.body !== undefined && { 'content-type': 'application/json' }),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    allowPrivate: app.settings.get('allowPrivateNetworkTargets'),
    timeoutMs: opts.timeoutMs ?? 15_000,
    signal: opts.signal,
    maxBytes: 10 * 1024 * 1024,
  }).catch((err: unknown) => {
    if (opts.signal?.aborted) throw err;
    // undici reports every network failure as "fetch failed"; the cause says what actually happened.
    throw new Error(`${new URL(url).host}: couldn't connect (${networkCause(err)})`);
  });
  const text = new TextDecoder().decode(res.body);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok && res.status !== 304) {
    const message =
      (data && typeof data === 'object' && ('message' in data || 'error' in data)
        ? String(
            (data as { message?: unknown; error?: unknown }).message ??
              (data as { error: unknown }).error,
          )
        : text.slice(0, 200)) || `HTTP ${res.status}`;
    throw new ApiCallError(res.status, `${new URL(url).host}: ${message} (HTTP ${res.status})`);
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmacHex = (secret: string, body: string) =>
  createHmac('sha256', secret).update(body).digest('hex');

/** "https://code.example.com/" → "https://code.example.com" */
export const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');

/** "owner/name" lines or commas → a clean list. */
export function repoList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((r) => r.trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean),
    ),
  ];
}

/** "ECONNREFUSED", "certificate has expired"… out of a fetch error and its causes. */
export function networkCause(err: unknown): string {
  let e = err as { message?: string; code?: string; cause?: unknown } | undefined;
  let last = e?.message ?? String(err);
  while (e) {
    if (e.code) return e.code;
    if (e.message && e.message !== 'fetch failed') last = e.message;
    e = e.cause as typeof e;
  }
  return last;
}
