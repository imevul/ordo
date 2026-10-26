import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import postgres from 'postgres';
import { buildApp } from '../src/app.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { loadEnv } from '../src/env.ts';

export async function testApp(overrides: Parameters<typeof loadEnv>[0] = {}) {
  const app = await buildApp(
    loadEnv({
      databaseUrl: process.env.TEST_DATABASE_URL!,
      storage: { driver: 'local', dir: mkdtempSync(join(tmpdir(), 'ordo-test-uploads-')) },
      ...overrides,
      settingsFromEnv: { signupMode: 'open', ...overrides.settingsFromEnv },
    }),
    { logger: false },
  );
  await runMigrations(app.db);
  await app.settings.reload();
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

/** Creates (or recreates) an empty database next to the test database and returns its URL. */
export async function freshDatabase(name: string) {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  base.pathname = `/${name}`;
  return base.toString();
}

/** Captures outgoing email instead of talking SMTP. Returns the inbox. */
export function captureMail(app: FastifyInstance) {
  const inbox: { to: string; subject: string; text: string }[] = [];
  app.mailer.send = async (to, email) => {
    inbox.push({ to, subject: email.subject, text: email.text });
  };
  return inbox;
}

/** The first URL in a captured email. */
export const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? '';
