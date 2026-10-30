import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PgDialect, PgSession } from 'drizzle-orm/pg-core';
import { loadEnv } from '../env.ts';
import { inviteTokenAad } from '../lib/invites.ts';
import { Keyring } from '../lib/secrets.ts';
import type { Db } from './client.ts';

/** Finds the drizzle/ folder both from source (src/db) and from the bundle (dist/). */
export function migrationsFolder() {
  if (process.env.ORDO_MIGRATIONS_DIR) return process.env.ORDO_MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, '../../drizzle'),
    join(here, '../drizzle'),
    join(here, 'drizzle'),
  ]) {
    if (existsSync(join(candidate, 'meta/_journal.json'))) return candidate;
  }
  throw new Error('Could not locate the drizzle migrations folder');
}

/**
 * Backfills SQL can't do because they need ORDO_SECRET_KEY, each run just before the migration it
 * names. They must be idempotent: they also run on databases that already went past that point.
 */
const BEFORE: Record<string, (db: Db, keyring: Keyring) => Promise<void>> = {
  '0052_drop_invite_token': encryptInviteTokens,
};

/** Applies pending migrations, pausing for the code backfills in `BEFORE`. */
export async function runMigrations(db: Db, keyring?: Keyring) {
  const folder = migrationsFolder();
  const config = { migrationsFolder: folder };
  const migrations = readMigrationFiles(config);
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));
  const tags: string[] = journal.entries.map((e: { tag: string }) => e.tag);
  // drizzle's migrate() is exactly `dialect.migrate(all files)`, which skips the ones already
  // applied; the two fields are only hidden from its types.
  const { dialect, session } = db as unknown as { dialect: PgDialect; session: PgSession };
  for (const [tag, backfill] of Object.entries(BEFORE)) {
    const at = tags.indexOf(tag);
    if (at < 0) continue;
    await dialect.migrate(migrations.slice(0, at), session, config);
    keyring ??= defaultKeyring();
    await backfill(db, keyring);
  }
  await dialect.migrate(migrations, session, config);
}

function defaultKeyring() {
  const env = loadEnv();
  return new Keyring(env.secretKey, env.previousSecretKey);
}

/**
 * Invites used to keep their token in plain text. Encrypts what's left of it so admins can still
 * copy and resend those links; `0051` already stored the hash that sign-ups look it up by. Without
 * a key the links keep working, but can't be shown again.
 */
async function encryptInviteTokens(db: Db, keyring: Keyring) {
  const [plain] = await db.execute(sql`select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'invites' and column_name = 'token'`);
  if (!plain) return;
  const rows = (await db.execute(
    sql`select id, token from invites where token_encrypted is null`,
  )) as unknown as { id: string; token: string }[];
  if (!rows.length) return;
  if (!keyring.available) {
    console.warn(
      `ORDO_SECRET_KEY is not set: ${rows.length} pending invite link(s) can't be shown again. They keep working.`,
    );
    return;
  }
  for (const row of rows) {
    const encrypted = keyring.encrypt(row.token, inviteTokenAad(row.id));
    await db.execute(sql`update invites set token_encrypted = ${encrypted} where id = ${row.id}`);
  }
}
