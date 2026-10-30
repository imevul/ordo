import type { InstanceSettings } from '@ordo/shared';
import { and, eq, getTableColumns, inArray, isNotNull, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.ts';
import {
  authProviders,
  imports,
  instanceKeys,
  instanceSettings,
  integrationApps,
  integrations,
  matrixCryptoStores,
  users,
  webhooks,
  workspaceAiProviders,
} from '../db/schema.ts';
import type { Keyring } from '../lib/secrets.ts';
import type { Settings } from './settings.ts';

/**
 * Every column that holds a `keyring.encrypt` value, with the associated data it was encrypted
 * under. `rotate-key` walks this list, and `test/secret-key.test.ts` fails when a source file
 * encrypts under an AAD that isn't here, so new secrets can't be forgotten in a rotation.
 */
export const ENCRYPTED_COLUMNS: {
  table: PgTable;
  id: PgColumn;
  column: PgColumn;
  aad: (id: string) => string;
}[] = [
  { table: users, id: users.id, column: users.totpSecret, aad: (id) => `users:${id}:totp_secret` },
  {
    table: authProviders,
    id: authProviders.id,
    column: authProviders.clientSecret,
    aad: (id) => `auth_providers:${id}:client_secret`,
  },
  {
    table: webhooks,
    id: webhooks.id,
    column: webhooks.secret,
    aad: (id) => `webhooks:${id}:secret`,
  },
  {
    table: integrationApps,
    id: integrationApps.id,
    column: integrationApps.secrets,
    aad: (id) => `integration_apps:${id}:secrets`,
  },
  {
    table: integrations,
    id: integrations.id,
    column: integrations.secrets,
    aad: (id) => `integrations:${id}:secrets`,
  },
  {
    table: matrixCryptoStores,
    id: matrixCryptoStores.integrationId,
    column: matrixCryptoStores.data,
    aad: (id) => `matrix_crypto_stores:${id}:data`,
  },
  {
    table: workspaceAiProviders,
    id: workspaceAiProviders.workspaceId,
    column: workspaceAiProviders.apiKey,
    aad: (id) => `workspace_ai_providers:${id}:apiKey`,
  },
  { table: imports, id: imports.id, column: imports.secrets, aad: (id) => `imports:${id}:secrets` },
  {
    table: instanceKeys,
    id: instanceKeys.key,
    column: instanceKeys.value,
    aad: (key) => `instance_keys:${key}:value`,
  },
];

/** Encrypted fields inside instance settings (jsonb). Values set by env variables are plain. */
export const ENCRYPTED_SETTINGS = [
  { key: 'smtp', field: 'url', aad: 'instance_settings:smtp:url' },
  { key: 'ai', field: 'apiKey', aad: 'instance_settings:ai:apiKey' },
] as const;

const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith('v1.');

/** Stored settings straight from the table: env overrides don't hide what's in the database. */
async function storedSettings(db: Db) {
  const rows = await db
    .select()
    .from(instanceSettings)
    .where(
      inArray(
        instanceSettings.key,
        ENCRYPTED_SETTINGS.map((s) => s.key),
      ),
    );
  return new Map(rows.map((r) => [r.key, r.value as Record<string, unknown> | null]));
}

/**
 * How many stored secrets this keyring can't decrypt: encrypted under a key that is neither
 * ORDO_SECRET_KEY nor ORDO_SECRET_KEY_PREVIOUS. Anything above 0 means a wrong key, or a previous
 * key removed before `rotate-key` moved everything over.
 */
export async function countUnreadableSecrets(db: Db, keyring: Keyring): Promise<number> {
  const kids = keyring.keyIds;
  const known = (expr: unknown) =>
    kids.length ? sql`split_part(${expr}, '.', 2) not in ${kids}` : sql`true`;
  const counts = await Promise.all(
    ENCRYPTED_COLUMNS.map(async ({ table, column }) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(and(isNotNull(column), sql`${column} like 'v1.%'`, known(column)));
      return row?.n ?? 0;
    }),
  );
  let n = counts.reduce((a, b) => a + b, 0);
  const settings = await storedSettings(db);
  for (const { key, field } of ENCRYPTED_SETTINGS) {
    const value = settings.get(key)?.[field];
    if (isEncrypted(value) && !kids.includes(value.split('.')[1]!)) n++;
  }
  return n;
}

/**
 * Re-encrypts every stored secret that isn't under the current key. A value another server
 * changed meanwhile is left alone (the update matches the old ciphertext); one that can't be
 * decrypted at all is counted in `failed`.
 */
export async function rotateSecrets(db: Db, settings: Settings, keyring: Keyring) {
  let rotated = 0;
  const failed: string[] = [];
  for (const { table, id, column, aad } of ENCRYPTED_COLUMNS) {
    // `set` takes the schema's property name, not the SQL column name.
    const field = Object.entries(getTableColumns(table)).find(([, c]) => c === column)![0];
    const rows = await db.select({ id: id, value: column }).from(table).where(isNotNull(column));
    for (const row of rows as { id: string; value: string }[]) {
      if (!isEncrypted(row.value) || !keyring.needsRotation(row.value)) continue;
      let next: string;
      try {
        next = keyring.encrypt(keyring.decrypt(row.value, aad(row.id)), aad(row.id));
      } catch {
        failed.push(aad(row.id));
        continue;
      }
      const done = await db
        .update(table)
        .set({ [field]: next } as never)
        .where(and(eq(id, row.id), eq(column, row.value)))
        .returning({ id });
      if (done.length) rotated++;
    }
  }
  const stored = await storedSettings(db);
  for (const { key, field, aad } of ENCRYPTED_SETTINGS) {
    const value = stored.get(key);
    const secret = value?.[field];
    if (!value || !isEncrypted(secret) || !keyring.needsRotation(secret)) continue;
    let next: string;
    try {
      next = keyring.encrypt(keyring.decrypt(secret, aad), aad);
    } catch {
      failed.push(aad);
      continue;
    }
    await settings.set(key, { ...value, [field]: next } as InstanceSettings[typeof key], null);
    rotated++;
  }
  return { rotated, failed };
}
