import type {
  Bootstrap,
  HistoryEntry,
  Import,
  IssueDetail,
  PlaceholderSummary,
} from '@ordo/shared';
import { and, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.ts';
import { auditLog, issueSubscribers, notifications, users } from '../src/db/schema.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { MERGED_COLUMNS, UNMERGED_COLUMNS } from '../src/services/placeholders.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let boot: Bootstrap;
const slug = `ph-${Date.now()}`;
const ws = `/api/w/${slug}`;

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

/** Uploads a CSV, lets `adjust` change the suggested mapping, and runs the import. */
async function importCsv(csv: string, adjust?: (imp: Import) => Partial<Import['mapping']>) {
  const boundary = '----ordo-ph';
  const res = await app.inject({
    method: 'POST',
    url: `${ws}/imports`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="people.csv"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
      Buffer.from(csv),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  const id = res.json().id as string;
  await settle();
  let imp = (await owner.get(`${ws}/imports/${id}`)).data as Import;
  if (adjust) {
    await owner.patch(`${ws}/imports/${id}`, { mapping: { ...imp.mapping!, ...adjust(imp) } });
  }
  const started = await owner.post(`${ws}/imports/${id}/run`);
  expect(started.statusCode, started.body).toBe(200);
  await settle();
  imp = (await owner.get(`${ws}/imports/${id}`)).data as Import;
  expect(imp.status).toBe('completed');
  return imp;
}

const refresh = async () => {
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  return boot;
};
const issue = async (identifier: string) =>
  (await owner.get(`${ws}/issues/${identifier}`)).data as IssueDetail;
const placeholderNamed = (name: string) => boot.placeholders.find((p) => p.name === name)!;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olive Owner')).client;
  await owner.post('/api/workspaces', { name: 'People', slug, teamName: 'Alpha', teamKey: 'ALP' });
  await owner.post(`${ws}/teams`, { name: 'Secret', key: 'SEC', private: true });
  await refresh();
});
afterAll(async () => {
  await app.close();
});

describe('placeholders', () => {
  const csv = [
    'ID,Team,Title,Assignee,Creator',
    'ALP-1,Alpha,Write the brief,carol@example.com,Dave Doe',
    'ALP-2,Alpha,Review the brief,Dave Doe,carol@example.com',
    'SEC-1,Secret,Quiet plan,carol@example.com,',
  ].join('\n');

  it('stand in for people nobody matches', async () => {
    const imp = await importCsv(csv, () => ({
      teams: {
        alpha: { teamId: boot.teams.find((t) => t.key === 'ALP')!.id },
        secret: { teamId: boot.teams.find((t) => t.key === 'SEC')!.id },
      },
    }));
    expect(imp.report!.created.people).toBe(2);
    await refresh();
    const carol = placeholderNamed('carol@example.com');
    const dave = placeholderNamed('Dave Doe');
    expect(carol).toMatchObject({ email: '', avatarUrl: null });
    expect(boot.members.map((m) => m.id)).not.toContain(carol.id);

    const brief = (
      await app.db.select().from(schema.issues).where(eq(schema.issues.title, 'Write the brief'))
    )[0]!;
    expect(brief.assigneeId).toBe(carol.id);
    expect(brief.creatorId).toBe(dave.id);

    const [row] = await app.db.select().from(users).where(eq(users.id, carol.id));
    expect(row).toMatchObject({
      kind: 'placeholder',
      passwordHash: null,
      importedEmail: 'carol@example.com',
    });
    // Their real address stays free for the account they'll sign up with.
    expect(row!.email).not.toBe('carol@example.com');

    const list = (await owner.get(`${ws}/placeholders`)).data as PlaceholderSummary[];
    expect(list.find((p) => p.id === carol.id)).toMatchObject({
      assigned: 2,
      created: 1,
      suggestedUserId: null,
    });
  });

  it("can't be picked, mentioned or notified, but don't get in the way of edits", async () => {
    const carol = placeholderNamed('carol@example.com');
    const brief = (
      await app.db.select().from(schema.issues).where(eq(schema.issues.title, 'Write the brief'))
    )[0]!;
    const alpha = boot.teams.find((t) => t.key === 'ALP')!;

    const created = await owner.post(`${ws}/issues`, {
      teamId: alpha.id,
      title: 'Hand to Carol',
      assigneeId: carol.id,
    });
    expect(created.statusCode).toBe(400);
    // A client re-sending the current assignee along with another change is fine.
    const edit = await owner.patch(`${ws}/issues/${brief.id}`, {
      title: 'Write the brief (v2)',
      assigneeId: carol.id,
    });
    expect(edit.statusCode, edit.body).toBe(200);

    await owner.post(`${ws}/issues/${brief.id}/comments`, { body: `Ping @${carol.username}` });
    await owner.patch(`${ws}/issues/${brief.id}`, { priority: 1 });
    const theirs = await app.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, carol.id));
    expect(theirs).toHaveLength(0);

    // Not human: even with a password hash set, the right password doesn't sign them in.
    await app.db
      .update(users)
      .set({ passwordHash: await hashPassword('placeholder-password') })
      .where(eq(users.id, carol.id));
    const [row] = await app.db.select().from(users).where(eq(users.id, carol.id));
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: row!.email, password: 'placeholder-password' },
    });
    expect(login.statusCode, login.body).toBe(401);
    await app.db.update(users).set({ passwordHash: null }).where(eq(users.id, carol.id));
  });

  it('are reused by later imports of the same people', async () => {
    const carol = placeholderNamed('carol@example.com');
    const imp = await importCsv('Title,Assignee\nFollow-up,carol@example.com', () => ({
      teams: { '*': { teamId: boot.teams.find((t) => t.key === 'ALP')!.id } },
    }));
    expect(imp.mapping!.users['carol@example.com']).toBe(carol.id);
    expect(imp.report!.created.people).toBe(0);
  });

  it('merge into a member who joins later', async () => {
    const carol = placeholderNamed('carol@example.com');
    const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
    const real = await signup(app, 'Carol Real', {
      inviteToken: invite.token,
      email: 'carol@example.com',
    });
    const realId = (await real.client.get('/api/auth/me')).data.id as string;

    const list = (await owner.get(`${ws}/placeholders`)).data as PlaceholderSummary[];
    expect(list.find((p) => p.id === carol.id)!.suggestedUserId).toBe(realId);

    const asMember = await real.client.post(`${ws}/placeholders/${carol.id}/merge`, {
      userId: realId,
    });
    expect(asMember.statusCode).toBe(403);
    const brief = await issue('ALP-1');
    const res = await owner.post(`${ws}/placeholders/${carol.id}/merge`, { userId: realId });
    expect(res.statusCode, res.body).toBe(200);
    // Carol isn't in the private team, so its issue loses its assignee instead of hiding from her.
    expect(res.data).toEqual({ assigned: 2, unassigned: 1 });

    expect((await issue('ALP-1')).assigneeId).toBe(realId);
    expect((await issue('ALP-2')).creatorId).toBe(realId);
    expect((await issue('SEC-1')).assigneeId).toBeNull();
    // The hand-over shows in the issues' history, without notifying anyone.
    const history = (await owner.get(`${ws}/issues/${brief.id}/history`)).data as HistoryEntry[];
    expect(history.flatMap((h) => h.changes)).toContainEqual({
      field: 'assignee',
      from: carol.id,
      to: realId,
    });
    const told = await app.db.select().from(notifications).where(eq(notifications.userId, realId));
    expect(told).toHaveLength(0);
    const subs = await app.db
      .select()
      .from(issueSubscribers)
      .where(eq(issueSubscribers.issueId, brief.id));
    expect(subs.map((s) => s.userId)).toContain(realId);

    await refresh();
    expect(boot.placeholders.find((p) => p.id === carol.id)).toBeUndefined();
    const [gone] = await app.db.select().from(users).where(eq(users.id, carol.id));
    expect(gone).toBeUndefined();
    const audit = await app.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.workspaceId, boot.workspace.id), eq(auditLog.action, 'placeholder.merged')),
      );
    expect(audit[0]!.data).toMatchObject({
      placeholder: 'carol@example.com',
      member: 'Carol Real',
    });
  });

  it('only merge into members of the workspace', async () => {
    const dave = placeholderNamed('Dave Doe');
    const outsider = await signup(app, 'Out Sider');
    const outsiderId = (await outsider.client.get('/api/auth/me')).data.id as string;
    const res = await owner.post(`${ws}/placeholders/${dave.id}/merge`, { userId: outsiderId });
    expect(res.statusCode).toBe(400);
  });

  it('cover every column that refers to a user', () => {
    const covered = new Set([
      ...MERGED_COLUMNS.map((c) => `${getTableConfig(c.table as PgTable).name}.${c.name}`),
      ...Object.keys(UNMERGED_COLUMNS),
    ]);
    const missing: string[] = [];
    for (const table of Object.values(schema)) {
      if (!(table instanceof PgTable)) continue;
      const config = getTableConfig(table);
      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        if (getTableConfig(ref.foreignTable).name !== 'users') continue;
        for (const column of ref.columns) {
          const name = `${config.name}.${column.name}`;
          if (!covered.has(name)) missing.push(name);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
