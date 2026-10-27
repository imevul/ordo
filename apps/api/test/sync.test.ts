import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Bootstrap, RealtimeEvent, SyncIssuePage } from '@ordo/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncChanges, syncCursors } from '../src/db/schema.ts';
import { pruneChanges } from '../src/services/sync.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let wsId: string;
let teamId: string;
const slug = `sync-${Date.now()}`;
const ws = `/api/w/${slug}`;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Sync Owner')).client;
  await owner.post('/api/workspaces', { name: 'Sync', slug, teamName: 'Core', teamKey: 'SYN' });
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  wsId = boot.workspace.id;
  teamId = boot.teams[0]!.id;
});
afterAll(() => app.close());

const changes = () =>
  app.db
    .select()
    .from(syncChanges)
    .where(eq(syncChanges.workspaceId, wsId))
    .orderBy(asc(syncChanges.seq));
const cursor = async () =>
  (await app.db.select().from(syncCursors).where(eq(syncCursors.workspaceId, wsId)))[0]!;
const newIssue = async (title: string, team = teamId) => {
  const res = await owner.post(`${ws}/issues`, { teamId: team, title });
  expect(res.statusCode).toBe(200);
  return res.data as { id: string };
};

describe('change log', () => {
  it('numbers changes without gaps or repeats, even when written at once', async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => newIssue(`Parallel ${i}`)),
    );
    const log = await changes();
    const seqs = log.map((c) => c.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    const issueIds = new Set(log.filter((c) => c.kind === 'issue').map((c) => c.entityId));
    for (const { id } of created) expect(issueIds.has(id)).toBe(true);
    expect((await cursor()).seq).toBe(seqs.length);
  });

  it('logs every kind of change, once per entity per transaction', async () => {
    const issue = await newIssue('Logged');
    await owner.post(`${ws}/issues/${issue.id}/comments`, { body: 'hello' });
    await owner.post(`${ws}/labels`, { name: `L${Date.now()}`, color: '#ff1493' });
    await owner.post(`${ws}/projects`, { name: 'Logged project', teamIds: [teamId] });
    const kinds = new Set((await changes()).map((c) => c.kind));
    for (const kind of ['issue', 'comment', 'label', 'project'])
      expect(kinds.has(kind), kind).toBe(true);
    const forIssue = (await changes()).filter((c) => c.entityId === issue.id);
    expect(forIssue[0]).toMatchObject({ kind: 'issue', action: 'created', teamIds: [teamId] });
  });

  it('records both teams when an issue moves', async () => {
    const other = (await owner.post(`${ws}/teams`, { name: 'Other', key: 'OTH', private: true }))
      .data.id as string;
    const issue = await newIssue('Mover');
    await owner.patch(`${ws}/issues/${issue.id}`, { teamId: other });
    const last = (await changes()).filter((c) => c.entityId === issue.id).at(-1)!;
    expect(last.teamIds.sort()).toEqual([teamId, other].sort());
  });

  it('stamps realtime events with their place in the log', async () => {
    const seen: RealtimeEvent[] = [];
    const publish = app.realtime.publish.bind(app.realtime);
    app.realtime.publish = (events) => {
      seen.push(...events);
      publish(events);
    };
    try {
      await newIssue('Stamped');
    } finally {
      app.realtime.publish = publish;
    }
    const { seq, epoch } = await cursor();
    expect(seen.find((e) => e.kind === 'issue')).toMatchObject({ seq, epoch });
  });

  it('logs changes made outside a workspace request too', async () => {
    const me = (await owner.get('/api/auth/me')).data;
    await owner.patch('/api/me', { name: 'Renamed Owner' });
    const last = (await changes()).at(-1)!;
    expect(last).toMatchObject({ kind: 'member', entityId: me.id, action: 'updated' });
  });

  it('starts a new epoch when a team is deleted', async () => {
    const before = await cursor();
    const doomed = (await owner.post(`${ws}/teams`, { name: 'Doomed', key: 'DOM' })).data.id;
    await newIssue('Doomed issue', doomed);
    expect((await owner.del(`${ws}/teams/${doomed}`)).statusCode).toBe(200);
    const after = await cursor();
    expect(after.epoch).toBe(before.epoch + 1);
    // Everything before the deletion needs a reload; the deletion itself is the first change after.
    expect(after.minSeq).toBe(after.seq - 1);
  });

  it('keeps 30 days', async () => {
    await app.db
      .update(syncChanges)
      .set({ createdAt: sql`now() - interval '31 days'` })
      .where(and(eq(syncChanges.workspaceId, wsId), sql`${syncChanges.seq} <= 5`));
    const before = await cursor();
    await pruneChanges(app.db);
    const after = await cursor();
    expect(after.minSeq).toBe(Math.max(before.minSeq, 5));
    expect((await changes())[0]!.seq).toBe(6);
  });
});

describe('publishing', () => {
  it('goes through runInWorkspace or publishChanges only', () => {
    const root = join(import.meta.dirname, '../src');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const path = join(dir, f);
        return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
      });
    const allowed = ['lib/mutate.ts', 'services/sync.ts', 'realtime.ts'];
    const offenders = files(root).filter(
      (f) =>
        !allowed.some((a) => f.endsWith(a)) &&
        readFileSync(f, 'utf8').includes('realtime.publish('),
    );
    // Publishing directly would tell open clients about a change that sync clients never hear of.
    expect(offenders).toEqual([]);
  });
});

describe('feed', () => {
  it('loads issues a page at a time', async () => {
    const all: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: SyncIssuePage = (await owner.post(`${ws}/sync/issues`, { after, limit: 7 })).data;
      all.push(...page.issues.map((i) => i.id));
      if (!page.next) break;
      after = page.next;
    }
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(20);
  });

  it('pages through changes and says when more are waiting', async () => {
    const snap = (await owner.get(`${ws}/sync/snapshot`)).data;
    for (let i = 0; i < 3; i++) await newIssue(`Feed ${i}`);
    const first = (
      await owner.get(`${ws}/sync/changes?since=${snap.seq}&epoch=${snap.epoch}&limit=2`)
    ).data;
    expect(first).toMatchObject({ more: true, seq: snap.seq + 2 });
    const rest = (await owner.get(`${ws}/sync/changes?since=${first.seq}&epoch=${snap.epoch}`))
      .data;
    expect(rest.more).toBe(false);
    // Within a page, issues come in no particular order: each is simply its current state.
    expect([...first.issues, ...rest.issues].map((i: { title: string }) => i.title).sort()).toEqual(
      ['Feed 0', 'Feed 1', 'Feed 2'],
    );
  });

  it('says when the bootstrap needs loading again', async () => {
    const snap = (await owner.get(`${ws}/sync/snapshot`)).data;
    await owner.post(`${ws}/labels`, { name: `Feed ${Date.now()}`, color: '#ff1493' });
    const got = (await owner.get(`${ws}/sync/changes?since=${snap.seq}&epoch=${snap.epoch}`)).data;
    expect(got).toMatchObject({ bootstrapChanged: true, issues: [], kinds: [] });
  });

  it('sends clients behind the pruned log back to the start', async () => {
    const { minSeq, epoch } = await cursor();
    expect(minSeq).toBeGreaterThan(0);
    const res = await owner.get(`${ws}/sync/changes?since=${minSeq - 1}&epoch=${epoch}`);
    expect(res.statusCode).toBe(410);
  });
});

describe('client-chosen ids', () => {
  let other: Client;
  beforeAll(async () => {
    const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
    other = (await signup(app, 'Other Member', { inviteToken: invite })).client;
  });

  it('make a retried create return what the first one made', async () => {
    const id = crypto.randomUUID();
    const first = await owner.post(`${ws}/issues`, { id, teamId, title: 'Made offline' });
    expect(first.statusCode).toBe(200);
    expect(first.data.id).toBe(id);
    const again = await owner.post(`${ws}/issues`, { id, teamId, title: 'Made offline' });
    expect(again.statusCode).toBe(200);
    expect(again.data).toMatchObject({ id, identifier: first.data.identifier });
    const [{ n }] = (await app.db.execute(
      sql`select count(*)::int as n from issues where id = ${id}`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(1);

    const commentId = crypto.randomUUID();
    const c1 = await owner.post(`${ws}/issues/${id}/comments`, { id: commentId, body: 'once' });
    const c2 = await owner.post(`${ws}/issues/${id}/comments`, { id: commentId, body: 'once' });
    expect([c1.data.id, c2.data.id]).toEqual([commentId, commentId]);
    const comments = (await owner.get(`${ws}/issues/${id}/comments`)).data;
    expect(comments.filter((c: { id: string }) => c.id === commentId)).toHaveLength(1);

    const target = await newIssue('Related');
    const relationId = crypto.randomUUID();
    const body = { id: relationId, type: 'related', relatedIssueId: target.id };
    const r1 = await owner.post(`${ws}/issues/${id}/relations`, body);
    const r2 = await owner.post(`${ws}/issues/${id}/relations`, body);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    expect([r1.data.id, r2.data.id]).toEqual([relationId, relationId]);
  });

  it("refuse an id someone else's thing already has", async () => {
    const id = crypto.randomUUID();
    await owner.post(`${ws}/issues`, { id, teamId, title: 'Mine' });
    const taken = await other.post(`${ws}/issues`, { id, teamId, title: 'Theirs' });
    expect(taken.statusCode).toBe(409);
    expect(taken.data.messageKey).toBe('id_taken');
    const commentId = crypto.randomUUID();
    await owner.post(`${ws}/issues/${id}/comments`, { id: commentId, body: 'mine' });
    const comment = await other.post(`${ws}/issues/${id}/comments`, { id: commentId, body: 'x' });
    expect(comment.statusCode).toBe(409);
  });
});
