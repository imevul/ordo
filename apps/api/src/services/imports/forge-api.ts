import type { FastifyInstance } from 'fastify';
import { ApiCallError, callApi } from '../../integrations/http.ts';
import { ImportAbort, ImportRetryLater } from './types.ts';

/** How to reach a forge's REST API: its base URL, how to sign in, and its name for messages. */
export interface ForgeApi {
  app: FastifyInstance;
  base: string;
  headers: Record<string, string>;
  name: string;
}

/** A GET, with whether there's a next page (from the `Link` header GitHub, Gitea and GitLab send). */
export async function forgeGet<T>(api: ForgeApi, path: string) {
  try {
    const res = await callApi<T>(api.app, `${api.base}${path}`, {
      headers: api.headers,
      timeoutMs: 30_000,
    });
    return { data: res.data, more: /rel="next"/.test(res.headers.get('link') ?? '') };
  } catch (err) {
    if (err instanceof ApiCallError) {
      // GitHub answers 403 "API rate limit exceeded"; the others (and GitHub's secondary limits) 429.
      if (err.status === 429 || /rate limit/i.test(err.message)) {
        throw new ImportRetryLater(
          `Waiting for ${api.name}'s rate limit; the import carries on by itself`,
          new Date(Date.now() + 10 * 60_000),
        );
      }
      if (err.status === 401) {
        throw new ImportAbort(`${api.name} refused the token: check it and start a new import`);
      }
    }
    throw err;
  }
}

/** Every page of a list; `path` already has its query, so `page` is appended. */
export async function forgeAll<T>(api: ForgeApi, path: string) {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const { data, more } = await forgeGet<T[]>(api, `${path}&page=${page}`);
    out.push(...data);
    if (!more || !data.length) return out;
  }
}

export const labelKey = (name: string) => `label:${name.trim().toLowerCase()}`;
