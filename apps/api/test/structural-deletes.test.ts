import type { Bootstrap, Issue, RealtimeEvent } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, syncChanges } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

// Deleting a cycle or a status moves its issues; each must look like an ordinary issue change.
let app: FastifyInstance;
let owner: Client;
let boot: Bootstrap;
const slug = `structural-${Date.now()}`;
const ws = `/api/w/${slug}`;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Struct Owner')).client;
  await owner.post('/api/workspaces', { name: 'Struct', slug, teamName: 'Core', teamKey: 'STR' });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
});
afterAll(() => app.close());

const team = () => boot.teams[0]!;
const newIssue = async (title: string, extra: Record<string, unknown> = {}) => {
  const res = await owner.post(`${ws}/issues`, { teamId: team().id, title, ...extra });
  expect(res.statusCode).toBe(200);
  return res.data as Issue;
};
const lastHistory = async (id: string) =>
  ((await owner.get(`${ws}/issues/${id}/history`)).data as { changes: unknown[] }[]).at(-1)!;
const issueUpdates = async () =>
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
  ).map((e) => ({ id: (e.data as { id: string }).id, changes: e.changes }));
const loggedIssueIds = async () =>
  (
    await app.db
      .select()
      .from(syncChanges)
      .where(and(eq(syncChanges.workspaceId, boot.workspace.id), eq(syncChanges.kind, 'issue')))
  ).map((c) => c.entityId);

/** Collects the realtime events published while `fn` runs. */
async function published(fn: () => Promise<unknown>) {
  const seen: RealtimeEvent[] = [];
  const publish = app.realtime.publish.bind(app.realtime);
  app.realtime.publish = (events) => {
    seen.push(...events);
    return publish(events);
  };
  try {
    await fn();
  } finally {
    app.realtime.publish = publish;
  }
  return seen;
}

describe('deleting a cycle', () => {
  it('takes its issues out of the cycle like an issue update', async () => {
    const cycle = (
      await owner.post(`${ws}/teams/${team().id}/cycles`, {
        startsAt: '2026-01-05',
        endsAt: '2026-01-19',
      })
    ).data;
    const a = await newIssue('In the cycle', { cycleId: cycle.id });
    const b = await newIssue('Also in it', { cycleId: cycle.id });
    const outside = await newIssue('Not in it');

    const events = await published(async () => {
      expect((await owner.del(`${ws}/cycles/${cycle.id}`)).statusCode).toBe(200);
    });

    for (const issue of [a, b]) {
      expect((await owner.get(`${ws}/issues/${issue.id}`)).data.cycleId).toBeNull();
      expect((await lastHistory(issue.id)).changes).toEqual([
        { field: 'cycle', from: cycle.id, to: null },
      ]);
    }
    const updated = events.filter((e) => e.kind === 'issue').map((e) => e.id);
    expect(updated.sort()).toEqual([a.id, b.id].sort());
    expect(events.some((e) => e.kind === 'cycle' && e.action === 'deleted')).toBe(true);
    const hooks = (await issueUpdates()).filter((e) => e.id === a.id || e.id === b.id);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]!.changes).toEqual([{ field: 'cycle', from: cycle.id, to: null }]);
    const logged = await loggedIssueIds();
    expect(logged).toContain(a.id);
    expect(logged).not.toContain(cycle.id);
    expect((await owner.get(`${ws}/issues/${outside.id}`)).data.cycleId).toBeNull();
  });
});

describe('deleting a status', () => {
  it('moves its issues to the replacement with history and events', async () => {
    const extra = (
      await owner.post(`${ws}/teams/${team().id}/states`, {
        name: 'Reviewing',
        type: 'started',
        color: '#ffffff',
      })
    ).data;
    const done = team().states.find((s) => s.type === 'completed')!;
    const a = await newIssue('Under review', { stateId: extra.id });
    const b = await newIssue('Also under review', { stateId: extra.id });
    expect(a.startedAt).not.toBeNull();

    const events = await published(async () => {
      const res = await owner.del(`${ws}/states/${extra.id}?moveTo=${done.id}`);
      expect(res.statusCode).toBe(200);
    });

    for (const issue of [a, b]) {
      const now = (await owner.get(`${ws}/issues/${issue.id}`)).data as Issue;
      expect(now.stateId).toBe(done.id);
      // Moving to a completed status completes the issue and keeps when it started.
      expect(now.completedAt).not.toBeNull();
      expect(now.startedAt).toBe(issue.startedAt);
      expect((await lastHistory(issue.id)).changes).toEqual([
        { field: 'state', from: extra.id, to: done.id },
      ]);
    }
    const updated = events.filter((e) => e.kind === 'issue').map((e) => e.id);
    expect(updated.sort()).toEqual([a.id, b.id].sort());
    const hooks = (await issueUpdates()).filter((e) => e.id === a.id || e.id === b.id);
    expect(hooks).toHaveLength(2);
    expect(await loggedIssueIds()).not.toContain(extra.id);
  });
});
