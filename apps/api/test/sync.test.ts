import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Bootstrap, RealtimeEvent } from '@ordo/shared';
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
