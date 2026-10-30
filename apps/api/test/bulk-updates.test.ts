import type { Bootstrap, HistoryEntry, Issue } from '@ordo/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notifications, syncChanges } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let boot: Bootstrap;
const slug = `bulk-${Date.now()}`;
const ws = `/api/w/${slug}`;
const team = () => boot.teams[0]!;
const stateOfType = (type: string) => team().states.find((s) => s.type === type)!;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Bulk Owner')).client;
  await owner.post('/api/workspaces', { name: 'Bulk', slug, teamName: 'Core', teamKey: 'BLK' });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
});
afterAll(() => app.close());

const newIssues = async (n: number, extra: Record<string, unknown> = {}) => {
  const out: Issue[] = [];
  for (let i = 0; i < n; i++) {
    const res = await owner.post(`${ws}/issues`, {
      teamId: team().id,
      title: `Bulk ${i}`,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(200);
    out.push(res.data);
  }
  return out;
};
const loggedSince = async (seq: number, ids: string[]) =>
  (
    await app.db
      .select()
      .from(syncChanges)
      .where(
        and(eq(syncChanges.workspaceId, boot.workspace.id), inArray(syncChanges.entityId, ids)),
      )
  ).filter((c) => c.seq > seq);
const lastSeq = async () =>
  Math.max(
    0,
    ...(
      await app.db
        .select({ seq: syncChanges.seq })
        .from(syncChanges)
        .where(eq(syncChanges.workspaceId, boot.workspace.id))
    ).map((r) => r.seq),
  );
const webhooksFor = async (id: string) =>
  (
    await app.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.workspaceId, boot.workspace.id),
          eq(domainEvents.type, 'issue.updated'),
        ),
      )
  ).filter((e) => e.data.id === id);
const history = async (id: string) =>
  (await owner.get(`${ws}/issues/${id}/history`)).data as HistoryEntry[];

describe('deleting a cycle', () => {
  it('takes its issues out through the issue service', async () => {
    const cycle = (
      await owner.post(`${ws}/teams/${team().id}/cycles`, {
        startsAt: '2030-01-01',
        endsAt: '2030-01-15',
      })
    ).data as { id: string };
    const list = await newIssues(3, { cycleId: cycle.id });
    const ids = list.map((i) => i.id);
    const since = await lastSeq();
    const notesBefore = (await app.db.select().from(notifications)).length;

    const res = await owner.del(`${ws}/cycles/${cycle.id}`);
    expect(res.statusCode, res.body).toBe(200);

    // Every issue reaches the change log under its own id; the cycle's id isn't passed off as one.
    const logged = await loggedSince(since, [...ids, cycle.id]);
    expect(
      logged
        .filter((c) => c.kind === 'issue')
        .map((c) => c.entityId)
        .sort(),
    ).toEqual([...ids].sort());
    for (const id of ids) {
      expect((await owner.get(`${ws}/issues/${id}`)).data.cycleId).toBeNull();
      expect((await history(id)).some((h) => h.changes.some((c) => c.field === 'cycle'))).toBe(
        true,
      );
      const [hook] = await webhooksFor(id);
      expect(hook?.changes).toEqual([{ field: 'cycle', from: cycle.id, to: null }]);
      expect(hook?.data).toMatchObject({ id, cycleId: null });
    }
    expect((await app.db.select().from(notifications)).length).toBe(notesBefore);
  });
});

describe('deleting a status', () => {
  it('moves its issues with history, sync changes, webhooks and state timestamps', async () => {
    const extra = (
      await owner.post(`${ws}/teams/${team().id}/states`, {
        name: 'Doing too',
        type: 'started',
        color: '#ff1493',
      })
    ).data as { id: string };
    const list = await newIssues(3, { stateId: extra.id });
    const ids = list.map((i) => i.id);
    const started = (await owner.get(`${ws}/issues/${ids[0]}`)).data as Issue;
    expect(started.startedAt).not.toBeNull();
    const done = stateOfType('completed');
    const since = await lastSeq();

    const res = await owner.del(`${ws}/states/${extra.id}?moveTo=${done.id}`);
    expect(res.statusCode, res.body).toBe(200);

    const logged = await loggedSince(since, [...ids, extra.id]);
    expect(
      logged
        .filter((c) => c.kind === 'issue')
        .map((c) => c.entityId)
        .sort(),
    ).toEqual([...ids].sort());
    for (const id of ids) {
      const issue = (await owner.get(`${ws}/issues/${id}`)).data as Issue;
      expect(issue.stateId).toBe(done.id);
      expect(issue.completedAt).not.toBeNull();
      expect(issue.canceledAt).toBeNull();
      expect(issue.startedAt).not.toBeNull();
      const entry = (await history(id)).find((h) => h.changes.some((c) => c.field === 'state'));
      expect(entry?.changes).toContainEqual({ field: 'state', from: extra.id, to: done.id });
      expect((await webhooksFor(id))[0]?.changes).toEqual([
        { field: 'state', from: extra.id, to: done.id },
      ]);
    }
    // The first issue started before; moving on keeps when it did.
    const first = (await owner.get(`${ws}/issues/${ids[0]}`)).data as Issue;
    expect(first.startedAt).toBe(started.startedAt);
  });

  it('clears state timestamps when issues move back to an unstarted status', async () => {
    const extra = (
      await owner.post(`${ws}/teams/${team().id}/states`, {
        name: 'Shipped too',
        type: 'completed',
        color: '#ff1493',
      })
    ).data as { id: string };
    const [issue] = await newIssues(1, { stateId: extra.id });
    const todo = stateOfType('unstarted');
    const res = await owner.del(`${ws}/states/${extra.id}?moveTo=${todo.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const after = (await owner.get(`${ws}/issues/${issue!.id}`)).data as Issue;
    expect(after).toMatchObject({
      stateId: todo.id,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
    });
  });

  it("doesn't put moved issues into the active cycle", async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const active = (
      await owner.post(`${ws}/teams/${team().id}/cycles`, { startsAt: day(-3), endsAt: day(4) })
    ).data as { id: string };
    const res0 = await owner.patch(`${ws}/teams/${team().id}`, {
      cycleAutomation: { enabled: true, addStarted: true },
    });
    expect(res0.statusCode, res0.body).toBe(200);
    const extra = (
      await owner.post(`${ws}/teams/${team().id}/states`, {
        name: 'Queued too',
        type: 'unstarted',
        color: '#ff1493',
      })
    ).data as { id: string };
    const [issue] = await newIssues(1, { stateId: extra.id });
    const doing = stateOfType('started');
    // An ordinary move to a started status would join the active cycle.
    const [control] = await newIssues(1);
    await owner.patch(`${ws}/issues/${control!.id}`, { stateId: doing.id });
    expect((await owner.get(`${ws}/issues/${control!.id}`)).data.cycleId).toBe(active.id);

    const res = await owner.del(`${ws}/states/${extra.id}?moveTo=${doing.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const after = (await owner.get(`${ws}/issues/${issue!.id}`)).data as Issue;
    expect(after.stateId).toBe(doing.id);
    expect(after.startedAt).not.toBeNull();
    expect(after.cycleId).toBeNull();
  });
});
