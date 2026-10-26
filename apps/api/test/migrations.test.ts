import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import { migrationsFolder } from '../src/db/migrate.ts';
import { freshDatabase } from './helpers.ts';

/** Copies the migrations folder with the journal cut down to the first `count` entries. */
function folderUpTo(count: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ordo-migrations-'));
  cpSync(migrationsFolder(), dir, { recursive: true });
  const journalPath = join(dir, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const entryIndex = (tag: string) => {
  const journal = JSON.parse(readFileSync(join(migrationsFolder(), 'meta/_journal.json'), 'utf8'));
  return journal.entries.findIndex((e: { tag: string }) => e.tag === tag);
};

describe('migrations', () => {
  const cleanup: (() => unknown)[] = [];
  afterAll(async () => {
    for (const fn of cleanup) await fn();
  });

  it('backfills the earliest user as instance admin', async () => {
    const url = await freshDatabase('ordo_test_migrations');
    const { db, sql } = createDb(url);
    cleanup.push(() => sql.end());

    const before = folderUpTo(entryIndex('0002_backfill_instance_admin'));
    cleanup.push(() => rmSync(before, { recursive: true, force: true }));
    await migrate(db, { migrationsFolder: before });
    await sql`insert into users (email, name, username, password_hash, created_at)
      values ('first@x.test', 'First', 'first', 'x', now() - interval '2 days'),
             ('second@x.test', 'Second', 'second', 'x', now() - interval '1 day')`;

    await migrate(db, { migrationsFolder: migrationsFolder() });
    const rows = await sql<{ email: string; is_instance_admin: boolean }[]>`
      select email, is_instance_admin from users order by created_at`;
    expect(rows.map((r) => [r.email, r.is_instance_admin])).toEqual([
      ['first@x.test', true],
      ['second@x.test', false],
    ]);
  });
});
