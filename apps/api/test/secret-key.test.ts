import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstanceSettings, SiteInvite } from '@ordo/shared';
import { eq, getTableColumns } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Secret, TOTP } from 'otpauth';
import { afterAll, describe, expect, it } from 'vitest';
import {
  authProviders,
  imports,
  instanceKeys,
  instanceSettings,
  integrationApps,
  integrations,
  matrixCryptoStores,
  users,
  workspaceAiProviders,
  workspaces,
} from '../src/db/schema.ts';
import { Keyring } from '../src/lib/secrets.ts';
import { decryptAiKey } from '../src/services/ai/assist.ts';
import { beginTotp, verifyTotp } from '../src/services/mfa.ts';
import * as secretKey from '../src/services/secretKey.ts';
import {
  countUnreadableSecrets,
  ENCRYPTED_COLUMNS,
  ENCRYPTED_SETTINGS,
  instanceKeyAad,
  rotateSecrets,
} from '../src/services/secretKey.ts';
import { Client, freshDatabase, signup, testApp } from './helpers.ts';

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

/** The second argument of a call whose arguments start at `from`, as written in the source. */
function secondArgument(text: string, from: number) {
  let depth = 0;
  let start = -1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return start < 0 ? null : text.slice(start, i).trim();
      depth--;
    } else if (ch === ',' && depth === 0) {
      if (start >= 0) return text.slice(start, i).trim();
      start = i + 1;
    }
  }
  return null;
}

describe('the list of encrypted columns', () => {
  const src = join(import.meta.dirname, '../src');
  // The keyring itself and the registry (whose rotation passes its own `aad`) are left out.
  const skip = [join('lib', 'secrets.ts'), join('services', 'secretKey.ts')];
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !skip.includes(f))
    .map((f) => ({ f, text: readFileSync(join(src, f), 'utf8') }));
  const helpers = Object.entries(secretKey).filter(([name]) => /(Aad|_AAD)$/.test(name)) as [
    string,
    string | ((id: string) => string),
  ][];

  it('lists every AAD helper, so rotate-key re-encrypts what they protect', () => {
    const listed = [
      ...ENCRYPTED_COLUMNS.map((c) => c.aad),
      ...ENCRYPTED_SETTINGS.map((s) => s.aad),
    ] as unknown[];
    expect(helpers.length).toBe(listed.length);
    expect(helpers.filter(([, h]) => !listed.includes(h)).map(([name]) => name)).toEqual([]);
  });

  it('keeps every AAD byte-for-byte, so stored ciphertexts still decrypt', () => {
    expect(
      Object.fromEntries(helpers.map(([n, h]) => [n, typeof h === 'function' ? h('X') : h])),
    ).toEqual({
      totpSecretAad: 'users:X:totp_secret',
      authProviderSecretAad: 'auth_providers:X:client_secret',
      webhookSecretAad: 'webhooks:X:secret',
      integrationAppSecretsAad: 'integration_apps:X:secrets',
      integrationSecretsAad: 'integrations:X:secrets',
      matrixCryptoStoreAad: 'matrix_crypto_stores:X:data',
      workspaceAiKeyAad: 'workspace_ai_providers:X:apiKey',
      importSecretsAad: 'imports:X:secrets',
      instanceKeyAad: 'instance_keys:X:value',
      inviteTokenAad: 'invites:X:token',
      SMTP_URL_AAD: 'instance_settings:smtp:url',
      AI_API_KEY_AAD: 'instance_settings:ai:apiKey',
    });
  });

  it('is the only place AADs are written out', () => {
    // `table:${id}:column` templates and 'table:key:field' literals: the shape every AAD has.
    const shaped = files.flatMap(({ f, text }) =>
      [
        ...text.matchAll(
          /`[a-z_]+:\$\{[^}]+\}:[A-Za-z_]+`|'(?:instance_[a-z]+):[a-z]+:[A-Za-z_]+'/g,
        ),
      ].map((m) => `${f}: ${m[0]}`),
    );
    expect(shaped).toEqual([]);
  });

  it('is what every encrypt and decrypt call uses', () => {
    const names = new Set(helpers.map(([name]) => name));
    const calls = files.flatMap(({ f, text }) =>
      [...text.matchAll(/keyring\.(?:encrypt|decrypt)\(/g)].map(
        (m) => `${f}: ${secondArgument(text, m.index + m[0].length)}`,
      ),
    );
    expect(calls.length).toBeGreaterThan(20);
    expect(
      calls.filter((c) => !names.has(/^([A-Za-z_$][\w$]*)/.exec(c.split(': ')[1]!)?.[1] ?? '')),
    ).toEqual([]);
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
    const rootA = await admin(a);
    const res = await rootA.patch('/api/admin/settings', {
      smtp: { url: 'smtps://mailer:s3cret@smtp.example.com:465', from: 'Ordo <ordo@example.com>' },
      ai: {
        provider: 'openai',
        model: 'llama3.3',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'local-key',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Secrets written the way the app writes them: a TOTP enrolment, a webhook, an instance key.
    const tess = await signup(a, 'Tess Totp');
    const id = await userId(tess.client);
    const { secret: totp } = await beginTotp(a.db, a.keyring, { id, email: tess.email });
    const slug = `rot${randomBytes(3).toString('hex')}`;
    const ws = await tess.client.post('/api/workspaces', {
      name: 'Rotation',
      slug,
      teamName: 'Core',
      teamKey: 'ROT',
    });
    expect(ws.statusCode, ws.body).toBe(200);
    const hook = await tess.client.post(`/api/w/${slug}/webhooks`, {
      url: 'https://hooks.example.com/ordo',
    });
    expect(hook.statusCode, hook.body).toBe(200);
    await a.db
      .insert(instanceKeys)
      .values({ key: 'test', value: a.keyring.encrypt('{"k":1}', instanceKeyAad('test')) });
    const invite = ((await rootA.post('/api/admin/invites', {})).data as SiteInvite[])[0]!;
    expect(invite.token).toBeTruthy();

    // The new key is current, the old one still decrypts.
    const b = await open(url, KEY_B);
    const rootB = await admin(b);
    const listedLink = async () =>
      ((await rootB.get('/api/admin/invites')).data as SiteInvite[]).find(
        (i) => i.id === invite.id,
      )!.token;
    const both = new Keyring(KEY_B, KEY_A);
    const onlyB = new Keyring(KEY_B);
    expect(await countUnreadableSecrets(b.db, both)).toBe(0);
    expect(await countUnreadableSecrets(b.db, onlyB)).toBe(6);
    expect(await listedLink()).toBeNull();

    expect(await rotateSecrets(b.db, b.settings, both)).toEqual({ rotated: 6, failed: [] });
    expect(await countUnreadableSecrets(b.db, onlyB)).toBe(0);
    // The invite link is readable under the new key alone, and is the same link.
    expect(await listedLink()).toBe(invite.token);
    expect((await new Client(b).get(`/api/invites/${invite.token}`)).statusCode).toBe(200);
    // Nothing left: a second run does nothing.
    expect(await rotateSecrets(b.db, b.settings, both)).toEqual({ rotated: 0, failed: [] });

    // A server that only has the new key reads everything back through its usual code paths.
    const c = await open(url, KEY_B);
    const [user] = await c.db.select().from(users).where(eq(users.id, id));
    const code = new TOTP({ secret: Secret.fromBase32(totp), digits: 6, period: 30 }).generate();
    expect(verifyTotp(c.keyring, { ...user!, email: tess.email }, code)).toBe(true);
    const owner = new Client(c);
    const login = await owner.post('/api/auth/login', {
      email: tess.email,
      password: 'correct horse battery',
    });
    expect(login.statusCode, login.body).toBe(200);
    const hookSecret = await owner.get(`/api/w/${slug}/webhooks/${hook.data.webhook.id}/secret`);
    expect(hookSecret.statusCode, hookSecret.body).toBe(200);
    expect(hookSecret.data.secret).toBe(hook.data.secret);
    expect(decryptAiKey(c, c.settings.get('ai')!.apiKey)).toBe('local-key');
    const root = await admin(c);
    const settings = (await root.get('/api/admin/settings')).data as {
      key: string;
      unreadable?: boolean;
      value: { url?: string };
    }[];
    expect(settings.filter((e) => e.unreadable)).toEqual([]);
    expect(settings.find((e) => e.key === 'smtp')!.value.url).toContain('smtp.example.com');
    const invites = (await root.get('/api/admin/invites')).data as SiteInvite[];
    expect(invites.find((i) => i.id === invite.id)!.token).toBe(invite.token);
    expect((await root.get('/api/admin/overview')).data).toMatchObject({
      secretKey: 'ok',
      unreadableSecrets: 0,
    });
    const [key] = await c.db.select().from(instanceKeys).where(eq(instanceKeys.key, 'test'));
    expect(c.keyring.decrypt(key!.value, instanceKeyAad('test'))).toBe('{"k":1}');

    // A value under a key it doesn't know is reported, not dropped.
    const stranger = new Keyring(randomBytes(32));
    await b.db
      .update(instanceKeys)
      .set({ value: stranger.encrypt('{"k":2}', instanceKeyAad('test')) })
      .where(eq(instanceKeys.key, 'test'));
    expect(await rotateSecrets(b.db, b.settings, both)).toEqual({
      rotated: 0,
      failed: ['instance_keys:test:value'],
    });
  });
});

describe('rotate-key, for every registered secret', () => {
  it('moves each entry of ENCRYPTED_COLUMNS and ENCRYPTED_SETTINGS to the new key', async () => {
    const url = await freshDatabase('secret_registry');
    const app = await open(url, KEY_A);
    const tess = await signup(app, 'Reg Istry');
    const slug = `reg${randomBytes(3).toString('hex')}`;
    await tess.client.post('/api/workspaces', {
      name: 'Reg',
      slug,
      teamName: 'Core',
      teamKey: 'REG',
    });
    const [ws] = await app.db.select().from(workspaces).where(eq(workspaces.slug, slug));
    const workspaceId = ws!.id;

    // One row per table, so each entry has something to rotate. A new entry fails below until it
    // gets a row here.
    await tess.client.post(`/api/w/${slug}/webhooks`, { url: 'https://hooks.example.com/r' });
    await tess.client.post(`/api/w/${slug}/invites`, { role: 'member' });
    await app.db.insert(authProviders).values({ workspaceId, name: 'Okta' });
    const [appRow] = await app.db
      .insert(integrationApps)
      .values({ provider: 'github', name: 'GitHub App' })
      .returning();
    const [integration] = await app.db
      .insert(integrations)
      .values({
        workspaceId,
        provider: 'matrix',
        appId: appRow!.id,
        name: 'Matrix',
        inboundToken: randomBytes(16).toString('hex'),
      })
      .returning();
    await app.db
      .insert(matrixCryptoStores)
      .values({ integrationId: integration!.id, data: 'placeholder' });
    await app.db
      .insert(workspaceAiProviders)
      .values({ workspaceId, provider: 'openai', model: 'm' });
    await app.db.insert(imports).values({ workspaceId, source: 'csv', name: 'x.csv' });
    await app.db.insert(instanceKeys).values({ key: 'registry', value: 'placeholder' });

    // Every value written under the old key, the way the app would, with the entry's own AAD.
    const oldKey = new Keyring(KEY_A);
    const written: { aad: string; plain: string; read: () => Promise<string | undefined> }[] = [];
    for (const { table, id, column, aad } of ENCRYPTED_COLUMNS) {
      const field = Object.entries(getTableColumns(table)).find(([, c]) => c === column)![0];
      const rows = (await app.db.select({ id }).from(table)) as { id: string }[];
      expect(rows.length, `no fixture row for ${aad('…')}`).toBeGreaterThan(0);
      for (const row of rows) {
        const plain = `secret for ${aad(row.id)}`;
        await app.db
          .update(table)
          .set({ [field]: oldKey.encrypt(plain, aad(row.id)) } as never)
          .where(eq(id, row.id));
        written.push({
          aad: aad(row.id),
          plain,
          read: async () =>
            (
              (await app.db.select({ v: column }).from(table).where(eq(id, row.id))) as {
                v: string;
              }[]
            )[0]?.v,
        });
      }
    }
    const fixtures: { [K in (typeof ENCRYPTED_SETTINGS)[number]['key']]: InstanceSettings[K] } = {
      smtp: { url: 'smtp://placeholder', from: 'Ordo <ordo@example.com>' },
      ai: { provider: 'openai', model: 'm', baseUrl: 'http://localhost:1/v1', apiKey: 'x' },
    };
    for (const { key, field, aad } of ENCRYPTED_SETTINGS) {
      const plain = `secret for ${aad}`;
      const value = { ...fixtures[key], [field]: oldKey.encrypt(plain, aad) };
      await app.settings.set(key, value as never, null);
      written.push({
        aad,
        plain,
        read: async () => {
          const [row] = await app.db
            .select()
            .from(instanceSettings)
            .where(eq(instanceSettings.key, key));
          return (row?.value as Record<string, string> | undefined)?.[field];
        },
      });
    }

    const onlyB = new Keyring(KEY_B);
    expect(await countUnreadableSecrets(app.db, onlyB)).toBe(written.length);
    expect(await rotateSecrets(app.db, app.settings, new Keyring(KEY_B, KEY_A))).toEqual({
      rotated: written.length,
      failed: [],
    });
    expect(await countUnreadableSecrets(app.db, onlyB)).toBe(0);
    for (const w of written) {
      const value = await w.read();
      expect(value, w.aad).toMatch(/^v1\./);
      expect(onlyB.decrypt(value!, w.aad), w.aad).toBe(w.plain);
    }
  });
});
