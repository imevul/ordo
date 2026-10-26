import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { loadEnv } from '../src/env.ts';

export async function testApp(overrides: Parameters<typeof loadEnv>[0] = {}) {
  const app = await buildApp(
    loadEnv({ databaseUrl: process.env.TEST_DATABASE_URL!, signupMode: 'open', ...overrides }),
    { logger: false },
  );
  await runMigrations(app.db);
  await app.ready();
  return app;
}

/** A tiny cookie-carrying client around app.inject. */
export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}

  async req(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<LightMyRequestResponse & { data: any }> {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: body as object,
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    const set = res.headers['set-cookie'];
    const first = Array.isArray(set) ? set[0] : set;
    if (first?.startsWith('ordo_session=')) this.cookie = first.split(';')[0]!;
    let data: unknown = null;
    try {
      data = res.json();
    } catch {}
    return Object.assign(res, { data });
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body ?? {});
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body ?? {});
  del = (url: string) => this.req('DELETE', url);
}

let n = 0;
export async function signup(
  app: FastifyInstance,
  name = 'Ada Lovelace',
  extra: Record<string, unknown> = {},
) {
  const c = new Client(app);
  n++;
  const email = `${name.split(' ')[0]!.toLowerCase()}${n}-${Date.now()}@example.com`;
  const res = await c.post('/api/auth/signup', {
    name,
    email,
    password: 'correct horse battery',
    ...extra,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  return { client: c, email, data: res.data };
}
