import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
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

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
