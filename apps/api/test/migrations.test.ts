import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import { migrationsFolder, runMigrations } from '../src/db/migrate.ts';
import { sha256 } from '../src/lib/crypto.ts';
import { Keyring } from '../src/lib/secrets.ts';
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

  it('takes people who left a workspace off its teams', async () => {
    const url = await freshDatabase('migrations_team_members');
    const { db, sql } = createDb(url);
    cleanup.push(() => sql.end());

    const before = folderUpTo(entryIndex('0037_drop_leftover_team_members'));
    cleanup.push(() => rmSync(before, { recursive: true, force: true }));
    await migrate(db, { migrationsFolder: before });
    const [stays, left] = await sql<{ id: string }[]>`insert into users (email, name, username)
      values ('stays@x.test', 'Stays', 'stays'), ('left@x.test', 'Left', 'left') returning id`;
    const [ws] = await sql<{ id: string }[]>`insert into workspaces (name, slug)
      values ('W', 'w') returning id`;
    const [team] = await sql<{ id: string }[]>`insert into teams (workspace_id, name, key)
      values (${ws!.id}, 'Core', 'COR') returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role)
      values (${ws!.id}, ${stays!.id}, 'owner')`;
    await sql`insert into team_members (team_id, user_id, role)
      values (${team!.id}, ${stays!.id}, 'admin'), (${team!.id}, ${left!.id}, 'member')`;

    await migrate(db, { migrationsFolder: migrationsFolder() });
    const rows = await sql<{ username: string }[]>`
      select u.username from team_members tm join users u on u.id = tm.user_id`;
    expect(rows.map((r) => r.username)).toEqual(['stays']);
  });

  it('hashes and encrypts invite tokens, then drops the plain column', async () => {
    const url = await freshDatabase('migrations_invite_tokens');
    const { db, sql } = createDb(url);
    cleanup.push(() => sql.end());

    const before = folderUpTo(entryIndex('0050_invite_token_hash'));
    cleanup.push(() => rmSync(before, { recursive: true, force: true }));
    await migrate(db, { migrationsFolder: before });
    const [invite] = await sql<{ id: string }[]>`insert into invites (token, expires_at)
      values ('legacy-token', now() + interval '1 day') returning id`;

    const keyring = new Keyring(randomBytes(32));
    await runMigrations(db, keyring);
    // Again, as on every boot: nothing left to do.
    await runMigrations(db, keyring);
    const columns = await sql<{ column_name: string }[]>`select column_name
      from information_schema.columns where table_name = 'invites'`;
    expect(columns.map((c) => c.column_name)).not.toContain('token');
    const [row] = await sql<{ token_hash: string; token_encrypted: string }[]>`
      select token_hash, token_encrypted from invites where id = ${invite!.id}`;
    expect(row!.token_hash).toBe(sha256('legacy-token'));
    expect(row!.token_encrypted).not.toContain('legacy-token');
    expect(keyring.decrypt(row!.token_encrypted, `invites:${invite!.id}:token`)).toBe(
      'legacy-token',
    );
  });

  it('lets instances booting together migrate one at a time', async () => {
    const url = await freshDatabase('migrations_parallel');
    const first = createDb(url);
    const second = createDb(url);
    cleanup.push(
      () => first.sql.end(),
      () => second.sql.end(),
    );

    // Leave both migrators SQL migrations on either side of the code backfill.
    const before = folderUpTo(entryIndex('0051_hash_invite_tokens'));
    cleanup.push(() => rmSync(before, { recursive: true, force: true }));
    await migrate(first.db, { migrationsFolder: before });
    await first.sql`insert into invites (token, expires_at)
      values ('legacy-token', now() + interval '1 day')`;

    // Count the backfill's writes to invites: it encrypts each pending token once.
    await first.sql`create table backfill_writes (n int)`;
    await first.sql`create function count_backfill() returns trigger language plpgsql as $$
      begin insert into backfill_writes values (1); return new; end $$`;
    await first.sql`create trigger count_backfill after update of token_encrypted on invites
      for each row execute function count_backfill()`;

    const keyring = new Keyring(randomBytes(32));
    await Promise.all([runMigrations(first.db, keyring), runMigrations(second.db, keyring)]);

    const applied = await first.sql<{ hash: string; n: number }[]>`
      select hash, count(*)::int as n from drizzle.__drizzle_migrations group by hash`;
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder(), 'meta/_journal.json'), 'utf8'),
    );
    expect(applied).toHaveLength(journal.entries.length);
    expect(applied.every((m) => m.n === 1)).toBe(true);
    expect(await first.sql`select * from backfill_writes`).toHaveLength(1);
    // The lock was released, not left behind on a pooled connection.
    expect(
      await first.sql`select 1 from pg_locks where locktype = 'advisory'
        and database = (select oid from pg_database where datname = current_database())`,
    ).toHaveLength(0);
  });

  it('keeps invite links working without a secret key, as a hash only', async () => {
    const url = await freshDatabase('migrations_invite_tokens_nokey');
    const { db, sql } = createDb(url);
    cleanup.push(() => sql.end());

    const before = folderUpTo(entryIndex('0050_invite_token_hash'));
    cleanup.push(() => rmSync(before, { recursive: true, force: true }));
    await migrate(db, { migrationsFolder: before });
    await sql`insert into invites (token, expires_at) values ('legacy-token', now() + interval '1 day')`;

    await runMigrations(db, new Keyring(null));
    expect(await sql`select token_hash, token_encrypted from invites`).toEqual([
      { token_hash: sha256('legacy-token'), token_encrypted: null },
    ]);
  });
});
