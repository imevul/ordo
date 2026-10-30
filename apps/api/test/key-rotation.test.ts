import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authProviders,
  imports,
  integrationApps,
  integrations,
  matrixCryptoStores,
  users,
  webhooks,
  workspaceAiProviders,
  workspaces,
} from '../src/db/schema.ts';
import {
  ENCRYPTED_COLUMNS,
  ENCRYPTED_SETTINGS,
  rotateSecrets,
  secretAad,
} from '../src/lib/encryptedColumns.ts';
import { Keyring } from '../src/lib/secrets.ts';
import { decryptAiKey, ownAiProvider } from '../src/services/ai/assist.ts';
import {
  readAppSecrets,
  readSecrets,
  sealAppSecrets,
  sealSecrets,
} from '../src/services/integrations.ts';
import { encryptSmtpUrl } from '../src/services/mailer.ts';
import { beginTotp } from '../src/services/mfa.ts';
import { vapidKeys } from '../src/services/push.ts';
import { freshDatabase, testApp } from './helpers.ts';

const OLD = Buffer.alloc(32, 7);
const NEW = Buffer.alloc(32, 8);

describe('every keyring.encrypt call is covered by rotate-key', () => {
  const src = join(import.meta.dirname, '../src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });

  /** The argument list of each `keyring.encrypt(`/`keyring.decrypt(` call in the source. */
  const calls = files(src)
    .filter((f) => !f.endsWith('lib/encryptedColumns.ts'))
    .flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/keyring\.(?:en|de)crypt\(/g)].map((m) => {
        let depth = 1;
        let i = m.index + m[0].length;
        for (; depth && i < text.length; i++)
          depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
        return { at: relative(src, file), args: text.slice(m.index + m[0].length, i - 1) };
      });
    });

  it('finds the call sites', () => {
    expect(calls.length).toBeGreaterThan(10);
  });

  it('takes the associated data from secretAad', () => {
    expect(calls.filter((c) => !/secretAad\.\w+\(/.test(c.args))).toEqual([]);
  });

  it('has a registry entry for every secretAad helper', () => {
    const registered = new Set<unknown>([
      ...ENCRYPTED_COLUMNS.map((c) => c.aad),
      ...ENCRYPTED_SETTINGS.map((s) => s.aad),
    ]);
    expect(Object.entries(secretAad).filter(([, fn]) => !registered.has(fn))).toEqual([]);
  });
});

describe('rotate-key', () => {
  let url: string;
  let before: FastifyInstance;
  let after: FastifyInstance | undefined;
  const plain = new Map<string, string>();
  let workspaceId: string;
  let integrationId: string;
  let appId: string;

  beforeAll(async () => {
    url = await freshDatabase('key_rotation');
    before = await testApp({ databaseUrl: url, secretKey: OLD, previousSecretKey: null });
    const { db, keyring } = before;

    const [user] = await db
      .insert(users)
      .values({ email: 'rot@example.com', name: 'Rot', username: 'rot' })
      .returning();
    const [ws] = await db.insert(workspaces).values({ name: 'Rot', slug: 'rot' }).returning();
    workspaceId = ws!.id;

    // Through the real write paths where they're easy to call, so their AADs are checked too.
    await beginTotp(db, keyring, { id: user!.id, email: user!.email });
    await before.settings.set(
      'smtp',
      { url: encryptSmtpUrl(before, 'smtp://u:p@mail'), from: 'a@b.c' },
      null,
    );
    await before.settings.set(
      'ai',
      {
        provider: 'anthropic',
        model: 'm',
        baseUrl: null,
        apiKey: keyring.encrypt('sk-instance', secretAad.aiApiKey()),
      },
      null,
    );
    await vapidKeys(before);

    appId = randomUUID();
    await db.insert(integrationApps).values({
      id: appId,
      provider: 'github',
      name: 'App',
      secrets: sealAppSecrets(before, appId, { privateKey: 'pem' }),
    });
    integrationId = randomUUID();
    await db.insert(integrations).values({
      id: integrationId,
      workspaceId,
      provider: 'github',
      name: 'GH',
      appId,
      inboundToken: randomUUID(),
      secrets: sealSecrets(before, integrationId, { token: 'ghp_x' }),
    });
    await db.insert(matrixCryptoStores).values({
      integrationId,
      data: keyring.encrypt('c3RvcmU=', secretAad.matrixCryptoStore(integrationId)),
    });

    const providerId = randomUUID();
    await db.insert(authProviders).values({
      id: providerId,
      workspaceId,
      name: 'SSO',
      issuer: 'https://idp.example',
      clientId: 'ordo',
      clientSecret: keyring.encrypt('client-secret', secretAad.ssoClientSecret(providerId)),
    });
    const webhookId = randomUUID();
    await db.insert(webhooks).values({
      id: webhookId,
      workspaceId,
      url: 'https://hooks.example',
      secret: keyring.encrypt('whsec_x', secretAad.webhookSecret(webhookId)),
    });
    await db.insert(workspaceAiProviders).values({
      workspaceId,
      provider: 'anthropic',
      model: 'm',
      apiKey: keyring.encrypt('sk-workspace', secretAad.workspaceAiKey(workspaceId)),
    });
    const importId = randomUUID();
    await db.insert(imports).values({
      id: importId,
      workspaceId,
      source: 'linear',
      name: 'Linear',
      secrets: keyring.encrypt('{"apiKey":"lin"}', secretAad.importSecrets(importId)),
    });

    for (const c of ENCRYPTED_COLUMNS)
      for (const row of await readColumn(before, c))
        plain.set(`${c.name}:${row.id}`, keyring.decrypt(row.value, c.aad(row.id)));
  });

  afterAll(async () => {
    await before?.close();
    await after?.close();
  });

  const readColumn = async (app: FastifyInstance, c: (typeof ENCRYPTED_COLUMNS)[number]) =>
    (await app.db
      .select({ id: c.id, value: c.column })
      .from(c.table)
      .where(isNotNull(c.column))) as { id: string; value: string }[];

  it('has a secret of every kind to rotate', async () => {
    for (const c of ENCRYPTED_COLUMNS) expect(await readColumn(before, c), c.name).not.toEqual([]);
  });

  it('re-encrypts everything so the old key can be dropped', async () => {
    const counts = await rotateSecrets(before.db, new Keyring(NEW, OLD));
    for (const c of counts) expect(c.rotated, c.name).toBeGreaterThan(0);
    expect(counts.find((c) => c.name === 'instance settings')!.rotated).toBe(
      ENCRYPTED_SETTINGS.length,
    );

    // Only the new key from here on.
    const keyring = new Keyring(NEW);
    for (const c of ENCRYPTED_COLUMNS)
      for (const row of await readColumn(before, c)) {
        expect(keyring.needsRotation(row.value), c.name).toBe(false);
        expect(keyring.decrypt(row.value, c.aad(row.id))).toBe(plain.get(`${c.name}:${row.id}`));
      }

    after = await testApp({ databaseUrl: url, secretKey: NEW, previousSecretKey: null });
    expect(after.keyring.decrypt(after.settings.get('smtp')!.url, secretAad.smtpUrl())).toBe(
      'smtp://u:p@mail',
    );
    expect(decryptAiKey(after, after.settings.get('ai')!.apiKey)).toBe('sk-instance');
    expect((await ownAiProvider(after, workspaceId))?.apiKey).toBe('sk-workspace');
    const [integration] = await after.db.select().from(integrations);
    expect(readSecrets(after, integration!)).toEqual({ token: 'ghp_x' });
    const [appRow] = await after.db.select().from(integrationApps);
    expect(readAppSecrets(after, appRow!)).toEqual({ privateKey: 'pem' });
  });

  it('is idempotent', async () => {
    const counts = await rotateSecrets(before.db, new Keyring(NEW, OLD));
    expect(counts.every((c) => c.rotated === 0)).toBe(true);
  });
});
