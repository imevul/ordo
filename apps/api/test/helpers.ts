import { randomBytes } from 'node:crypto';
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

/** A JSON body in a test. Tests read whatever fields they expect, so it stays loosely typed. */
// biome-ignore lint/suspicious/noExplicitAny: the one place tests opt out of typing JSON bodies
export type Json = any;

/** A tiny cookie-carrying client around app.inject. */
export class Client {
  cookie = '';
  /** `ip` sets where requests seem to come from (rate limits count per address). */
  constructor(
    private app: FastifyInstance,
    private opts: { ip?: string } = {},
  ) {}

  async req(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<LightMyRequestResponse & { data: Json }> {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: body as object,
      headers: this.cookie ? { cookie: this.cookie } : {},
      ...(this.opts.ip && { remoteAddress: this.opts.ip }),
    });
    const set = res.headers['set-cookie'];
    const session = (Array.isArray(set) ? set : [set]).find((c) => c?.startsWith('ordo_session='));
    if (session) this.cookie = session.split(';')[0]!;
    let data: unknown = null;
    try {
      data = res.json();
    } catch {}
    return Object.assign(res, { data });
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body ?? {});
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body ?? {});
  put = (url: string, body?: unknown) => this.req('PUT', url, body ?? {});
  del = (url: string) => this.req('DELETE', url);

  /** A one-file multipart upload, as the web client sends it. */
  async upload(
    url: string,
    filename: string,
    body: Buffer,
    contentType = 'application/octet-stream',
  ) {
    const boundary = '----ordo-test-upload';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await this.app.inject({
      method: 'POST',
      url,
      payload,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
    });
    let data: unknown = null;
    try {
      data = res.json();
    } catch {}
    return Object.assign(res, { data }) as LightMyRequestResponse & { data: Json };
  }
}

let n = 0;
export async function signup(
  app: FastifyInstance,
  name = 'Ada Lovelace',
  extra: Record<string, unknown> = {},
) {
  n++;
  // Each person signs up from their own address, so busy test files don't share a rate limit.
  const c = new Client(app, { ip: `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` });
  // Test files run in parallel workers, each counting from 1, so the time alone can collide.
  const email = `${name.split(' ')[0]!.toLowerCase()}${n}-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`;
  const res = await c.post('/api/auth/signup', {
    name,
    email,
    password: 'correct horse battery',
    ...extra,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  return { client: c, email, data: res.data };
}

/**
 * Creates (or recreates) an empty database next to the test database, named after it with `_<suffix>`
 * so that it belongs to this run, and returns its URL.
 */
export async function freshDatabase(suffix: string) {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const name = `${base.pathname.slice(1)}_${suffix}`;
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
