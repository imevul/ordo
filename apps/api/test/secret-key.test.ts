import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { instanceKeys, users } from '../src/db/schema.ts';
import { Keyring } from '../src/lib/secrets.ts';
import {
  countUnreadableSecrets,
  ENCRYPTED_COLUMNS,
  ENCRYPTED_SETTINGS,
  rotateSecrets,
} from '../src/services/secretKey.ts';
import { type Client, freshDatabase, signup, testApp } from './helpers.ts';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const apps: FastifyInstance[] = [];
const open = async (databaseUrl: string, secretKey: Buffer) => {
  const app = await testApp({
    databaseUrl,
    secretKey,
    previousSecretKey: null,
    settingsFromEnv: {},
  });
  apps.push(app);
  return app;
};
afterAll(async () => {
  for (const app of apps) await app.close();
});

const userId = async (c: Client) => (await c.get('/api/auth/me')).data.id as string;
const admin = async (app: FastifyInstance) => {
  const { client } = await signup(app, 'Root Admin');
  await app.db
    .update(users)
    .set({ isInstanceAdmin: true })
    .where(eq(users.id, await userId(client)));
  return client;
};

describe('the list of encrypted columns', () => {
  it('covers every AAD the source encrypts under', () => {
    const src = join(import.meta.dirname, '../src');
    const files = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ f, text: readFileSync(join(src, f), 'utf8') }));
    // `table:${id}:column` templates and 'table:key:field' literals: the shape every AAD has.
    const found = new Set<string>();
    for (const { text } of files) {
      for (const m of text.matchAll(/`([a-z_]+):\$\{[^}]+\}:([A-Za-z_]+)`/g))
        found.add(`${m[1]}::${m[2]}`);
      for (const m of text.matchAll(/'(instance_settings:[a-z]+:[A-Za-z_]+)'/g)) found.add(m[1]!);
    }
    const listed = new Set([
      ...ENCRYPTED_COLUMNS.map((c) => c.aad('')),
      ...ENCRYPTED_SETTINGS.map((s) => s.aad),
    ]);
    expect(found.size).toBeGreaterThanOrEqual(listed.size);
    expect([...found].filter((a) => !listed.has(a))).toEqual([]);

    // Every encrypt call names its AAD in a way the scan above sees (a literal or an *Aad/aad helper).
    const calls = files.flatMap(({ f, text }) =>
      [...text.matchAll(/keyring\.encrypt\(\s*[^,]+,\s*([^)\s]+)/g)].map((m) => `${f}: ${m[1]}`),
    );
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((c) => !/(Aad|aad|AAD)\b|^'|`/.test(c.split(': ')[1]!))).toEqual([]);
  });
});

describe('a wrong secret key', () => {
  it('leaves Admin → Settings usable and shows what to enter again', async () => {
    const url = await freshDatabase('secret_wrong');
    const a = await open(url, KEY_A);
    const res = await (await admin(a)).patch('/api/admin/settings', {
      smtp: { url: 'smtps://mailer:s3cret@smtp.example.com:465', from: 'Ordo <ordo@example.com>' },
      ai: {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        baseUrl: null,
        apiKey: 'sk-ant-0123456789abcdef',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await (await admin(a)).get('/api/admin/overview')).data).toMatchObject({
      secretKey: 'ok',
      unreadableSecrets: 0,
    });

    const b = await open(url, KEY_B);
    const root = await admin(b);
    const settings = await root.get('/api/admin/settings');
    expect(settings.statusCode, settings.body).toBe(200);
    const entry = (key: string) => settings.data.find((e: { key: string }) => e.key === key);
    expect(entry('smtp')).toMatchObject({
      unreadable: true,
      value: { url: null, from: 'Ordo <ordo@example.com>' },
    });
    expect(entry('ai')).toMatchObject({ unreadable: true, value: { apiKey: null } });
    expect((await root.get('/api/admin/overview')).data).toMatchObject({
      secretKey: 'unreadable',
      unreadableSecrets: 2,
    });

    // Keeping the unreadable value is refused; entering it again fixes it.
    const keep = await root.patch('/api/admin/settings', {
      smtp: { url: '', from: 'Ordo <ordo@example.com>' },
    });
    expect(keep.statusCode).toBe(400);
    const keepAi = await root.patch('/api/admin/settings', {
      ai: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: null, apiKey: '' },
    });
    expect(keepAi.statusCode).toBe(400);
    const again = await root.patch('/api/admin/settings', {
      smtp: { url: 'smtps://mailer:n3w@smtp.example.com:465', from: 'Ordo <ordo@example.com>' },
      ai: null,
    });
    expect(again.statusCode, again.body).toBe(200);
    const smtp = again.data.find((e: { key: string }) => e.key === 'smtp');
    expect(smtp.unreadable).toBeUndefined();
    expect(smtp.value.url).toContain('smtp.example.com');
    expect((await root.get('/api/admin/overview')).data.secretKey).toBe('ok');
  });
});

describe('rotate-key', () => {
  it('re-encrypts every stored secret with the new key', async () => {
    const url = await freshDatabase('secret_rotate');
    const a = await open(url, KEY_A);
    const res = await (await admin(a)).patch('/api/admin/settings', {
      smtp: { url: 'smtps://mailer:s3cret@smtp.example.com:465', from: 'Ordo <ordo@example.com>' },
      ai: {
        provider: 'openai',
        model: 'llama3.3',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'local-key',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const id = await userId((await signup(a, 'Tess Totp')).client);
    await a.db
      .update(users)
      .set({ totpSecret: a.keyring.encrypt('JBSWY3DPEHPK3PXP', `users:${id}:totp_secret`) })
      .where(eq(users.id, id));
    await a.db
      .insert(instanceKeys)
      .values({ key: 'test', value: a.keyring.encrypt('{"k":1}', 'instance_keys:test:value') });

    // The new key is current, the old one still decrypts.
    const b = await open(url, KEY_B);
    const both = new Keyring(KEY_B, KEY_A);
    const onlyB = new Keyring(KEY_B);
    expect(await countUnreadableSecrets(b.db, both)).toBe(0);
    expect(await countUnreadableSecrets(b.db, onlyB)).toBe(4);

    expect(await rotateSecrets(b.db, b.settings, both)).toEqual({ rotated: 4, failed: [] });
    expect(await countUnreadableSecrets(b.db, onlyB)).toBe(0);
    const [user] = await b.db.select().from(users).where(eq(users.id, id));
    expect(onlyB.decrypt(user!.totpSecret!, `users:${id}:totp_secret`)).toBe('JBSWY3DPEHPK3PXP');
    const [key] = await b.db.select().from(instanceKeys).where(eq(instanceKeys.key, 'test'));
    expect(onlyB.decrypt(key!.value, 'instance_keys:test:value')).toBe('{"k":1}');
    expect(onlyB.decrypt(b.settings.get('smtp')!.url, 'instance_settings:smtp:url')).toContain(
      's3cret',
    );
    expect(onlyB.decrypt(b.settings.get('ai')!.apiKey!, 'instance_settings:ai:apiKey')).toBe(
      'local-key',
    );
    // Nothing left: a second run does nothing.
    expect(await rotateSecrets(b.db, b.settings, both)).toEqual({ rotated: 0, failed: [] });

    // A value under a key it doesn't know is reported, not dropped.
    const stranger = new Keyring(randomBytes(32));
    await b.db
      .update(instanceKeys)
      .set({ value: stranger.encrypt('{"k":2}', 'instance_keys:test:value') })
      .where(eq(instanceKeys.key, 'test'));
    expect(await rotateSecrets(b.db, b.settings, both)).toEqual({
      rotated: 0,
      failed: ['instance_keys:test:value'],
    });
  });
});
