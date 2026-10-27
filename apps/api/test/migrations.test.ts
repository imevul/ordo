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

// Each test builds databases from scratch, which is slow on a busy machine.
describe('migrations', { timeout: 60_000 }, () => {
  const cleanup: (() => unknown)[] = [];
  afterAll(async () => {
    for (const fn of cleanup) await fn();
  });

  it('backfills the earliest user as instance admin', async () => {
    const url = await freshDatabase('migrations');
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

  it('gives every workspace an owner: its earliest admin, else its earliest member', async () => {
    const url = await freshDatabase('migrations_owner');
    const { db, sql } = createDb(url);
    cleanup.push(() => sql.end());

    const before = folderUpTo(entryIndex('0004_backfill_owners'));
    cleanup.push(() => rmSync(before, { recursive: true, force: true }));
    await migrate(db, { migrationsFolder: before });
    const [a, b, c] = await sql<
      { id: string }[]
    >`insert into users (email, name, username, password_hash) values
      ('a@x.test', 'A', 'a', 'x'), ('b@x.test', 'B', 'b', 'x'), ('c@x.test', 'C', 'c', 'x') returning id`;
    const [w1, w2] = await sql<{ id: string }[]>`insert into workspaces (name, slug) values
      ('One', 'one'), ('Two', 'two') returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role, joined_at) values
      (${w1!.id}, ${a!.id}, 'member', now() - interval '3 days'),
      (${w1!.id}, ${b!.id}, 'admin', now() - interval '2 days'),
      (${w1!.id}, ${c!.id}, 'admin', now() - interval '1 day'),
      (${w2!.id}, ${b!.id}, 'member', now() - interval '1 day'),
      (${w2!.id}, ${c!.id}, 'member', now() - interval '2 days')`;

    await migrate(db, { migrationsFolder: migrationsFolder() });
    const owners = await sql<{ slug: string; email: string }[]>`
      select w.slug, u.email from workspace_members m
      join workspaces w on w.id = m.workspace_id join users u on u.id = m.user_id
      where m.role = 'owner' order by w.slug`;
    expect(owners.map((o) => [o.slug, o.email])).toEqual([
      ['one', 'b@x.test'],
      ['two', 'c@x.test'],
    ]);
  });

  it('ties bots to their workspace, and marks bots without an integration as removed', async () => {
    const url = await freshDatabase('migrations_bots');
    const { db, sql } = createDb(url);
    cleanup.push(() => sql.end());

    const before = folderUpTo(entryIndex('0011_backfill_bot_workspace'));
    cleanup.push(() => rmSync(before, { recursive: true, force: true }));
    await migrate(db, { migrationsFolder: before });
    const [ws] = await sql<
      { id: string }[]
    >`insert into workspaces (name, slug) values ('W', 'w') returning id`;
    const [live, gone] = await sql<
      { id: string }[]
    >`insert into users (email, name, username, kind) values
      ('live@bots.test', 'Live bot', 'live-bot', 'bot'), ('gone@bots.test', 'Gone bot', 'gone-bot', 'bot') returning id`;
    await sql`insert into integrations (workspace_id, provider, name, bot_user_id, inbound_token)
      values (${ws!.id}, 'github', 'GitHub', ${live!.id}, 'tok')`;
    // The removed integration's bot only left a trace in the outbox.
    await sql`insert into domain_events (workspace_id, type, actor_id, source, data)
      values (${ws!.id}, 'issue.updated', ${gone!.id}, 'integration:x', '{}')`;

    await migrate(db, { migrationsFolder: migrationsFolder() });
    const bots = await sql<{ username: string; bot_workspace_id: string; removed: boolean }[]>`
      select username, bot_workspace_id, disabled_at is not null as removed from users order by username`;
    expect(bots).toEqual([
      { username: 'gone-bot', bot_workspace_id: ws!.id, removed: true },
      { username: 'live-bot', bot_workspace_id: ws!.id, removed: false },
    ]);
  });
});
