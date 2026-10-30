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
import type { Keyring } from './secrets.ts';

/**
 * Every value encrypted with the keyring, in one place. Write and read paths take their
 * associated data from `secretAad`, and `rotate-key` walks `ENCRYPTED_COLUMNS` and
 * `ENCRYPTED_SETTINGS`, so the two can't drift apart. A test fails when a `keyring.encrypt(`
 * call doesn't use `secretAad`, or when a helper here has no registry entry.
 */
export const secretAad = {
  totpSecret: (userId: string) => `users:${userId}:totp_secret`,
  ssoClientSecret: (id: string) => `auth_providers:${id}:client_secret`,
  webhookSecret: (id: string) => `webhooks:${id}:secret`,
  integrationSecrets: (id: string) => `integrations:${id}:secrets`,
  appSecrets: (id: string) => `integration_apps:${id}:secrets`,
  workspaceAiKey: (workspaceId: string) => `workspace_ai_providers:${workspaceId}:apiKey`,
  importSecrets: (importId: string) => `imports:${importId}:secrets`,
  matrixCryptoStore: (integrationId: string) => `matrix_crypto_stores:${integrationId}:data`,
  instanceKey: (key: string) => `instance_keys:${key}:value`,
  smtpUrl: () => 'instance_settings:smtp:url',
  aiApiKey: () => 'instance_settings:ai:apiKey',
};

export interface EncryptedColumn {
  name: string;
  table: PgTable;
  /** The column the AAD is bound to (the row's primary key). */
  id: PgColumn;
  column: PgColumn;
  aad: (id: string) => string;
}

export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  {
    name: 'TOTP secrets',
    table: users,
    id: users.id,
    column: users.totpSecret,
    aad: secretAad.totpSecret,
  },
  {
    name: 'SSO client secrets',
    table: authProviders,
    id: authProviders.id,
    column: authProviders.clientSecret,
    aad: secretAad.ssoClientSecret,
  },
  {
    name: 'webhook secrets',
    table: webhooks,
    id: webhooks.id,
    column: webhooks.secret,
    aad: secretAad.webhookSecret,
  },
  {
    name: 'integration secrets',
    table: integrations,
    id: integrations.id,
    column: integrations.secrets,
    aad: secretAad.integrationSecrets,
  },
  {
    name: 'integration app secrets',
    table: integrationApps,
    id: integrationApps.id,
    column: integrationApps.secrets,
    aad: secretAad.appSecrets,
  },
  {
    name: 'workspace AI keys',
    table: workspaceAiProviders,
    id: workspaceAiProviders.workspaceId,
    column: workspaceAiProviders.apiKey,
    aad: secretAad.workspaceAiKey,
  },
  {
    name: 'import credentials',
    table: imports,
    id: imports.id,
    column: imports.secrets,
    aad: secretAad.importSecrets,
  },
  {
    name: 'Matrix crypto stores',
    table: matrixCryptoStores,
    id: matrixCryptoStores.integrationId,
    column: matrixCryptoStores.data,
    aad: secretAad.matrixCryptoStore,
  },
  {
    name: 'instance keys (VAPID)',
    table: instanceKeys,
    id: instanceKeys.key,
    column: instanceKeys.value,
    aad: secretAad.instanceKey,
  },
];

/** Instance settings with an encrypted field. Values set through the environment stay plain. */
export const ENCRYPTED_SETTINGS: {
  name: string;
  key: keyof InstanceSettings;
  field: string;
  aad: () => string;
}[] = [
  { name: 'SMTP URL', key: 'smtp', field: 'url', aad: secretAad.smtpUrl },
  { name: 'instance AI key', key: 'ai', field: 'apiKey', aad: secretAad.aiApiKey },
];

const isCiphertext = (v: unknown): v is string => typeof v === 'string' && v.startsWith('v1.');

// Names the secret that failed, so an operator knows which one to fix or enter again.
function reencrypt(keyring: Keyring, value: string, aad: string, what: string) {
  try {
    return keyring.encrypt(keyring.decrypt(value, aad), aad);
  } catch (err) {
    throw new Error(`Could not re-encrypt ${what}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Re-encrypts every stored secret that isn't under the current key. Idempotent; one transaction
 * per table. Each update only applies if the value is still the one we read, so a server writing
 * the same row meanwhile (e.g. a Matrix crypto snapshot) wins instead of being overwritten.
 */
export async function rotateSecrets(db: Db, keyring: Keyring) {
  const counts: { name: string; rotated: number }[] = [];
  for (const c of ENCRYPTED_COLUMNS) {
    // `.set()` takes the TypeScript property name, not the SQL column name.
    const field = Object.entries(getTableColumns(c.table)).find(([, col]) => col === c.column)![0];
    const rotated = await db.transaction(async (tx) => {
      const rows = (await tx
        .select({ id: c.id, value: c.column })
        .from(c.table)
        .where(isNotNull(c.column))) as { id: string; value: string | null }[];
      let n = 0;
      for (const row of rows) {
        if (!isCiphertext(row.value) || !keyring.needsRotation(row.value)) continue;
        const aad = c.aad(row.id);
        await tx
          .update(c.table)
          .set({ [field]: reencrypt(keyring, row.value, aad, `${c.name} ${row.id}`) } as never)
          .where(and(eq(c.id, row.id), eq(c.column, row.value)));
        n++;
      }
      return n;
    });
    counts.push({ name: c.name, rotated });
  }

  const rotated = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(instanceSettings)
      .where(
        inArray(
          instanceSettings.key,
          ENCRYPTED_SETTINGS.map((s) => s.key),
        ),
      )
      .for('update');
    let n = 0;
    for (const s of ENCRYPTED_SETTINGS) {
      const row = rows.find((r) => r.key === s.key);
      const value = row?.value as Record<string, unknown> | null | undefined;
      const secret = value?.[s.field];
      if (!value || !isCiphertext(secret) || !keyring.needsRotation(secret)) continue;
      const aad = s.aad();
      await tx
        .update(instanceSettings)
        .set({ value: { ...value, [s.field]: reencrypt(keyring, secret, aad, s.name) } })
        .where(eq(instanceSettings.key, s.key));
      // Running servers cache settings; tell them to reload (delivered on commit).
      await tx.execute(sql`select pg_notify('ordo_settings', ${s.key})`);
      n++;
    }
    return n;
  });
  counts.push({ name: 'instance settings', rotated });
  return counts;
}
