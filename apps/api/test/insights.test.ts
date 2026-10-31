import type { Bootstrap, InsightsTimeline, Velocity } from '@ordo/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueTimeline, type ReplayIssue, snapshotsAt } from '../src/services/insights.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
const ws = '/api/w/charts';
const ids: Record<string, string> = {};
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const dayAgo = (days: number) => ago(days).slice(0, 10);

/** Moves an issue's latest change (and, with `created`, its creation) `days` back. */
async function backdate(issueId: string, days: number, created = false) {
  await app.db.execute(sql`update issue_history set created_at = ${ago(days)}
    where id = (select id from issue_history where issue_id = ${issueId} order by created_at desc limit 1)`);
  if (created)
    await app.db.execute(sql`update issues set created_at = ${ago(days)} where id = ${issueId}`);
}

const create = async (body: Record<string, unknown>, days: number) => {
  const issue = (await owner.post(`${ws}/issues`, { teamId: ids.team, ...body })).data;
  await backdate(issue.id, days, true);
  return issue.id as string;
};
const change = async (id: string, patch: Record<string, unknown>, days: number) => {
  expect((await owner.patch(`${ws}/issues/${id}`, patch)).statusCode).toBe(200);
  await backdate(id, days);
};

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Chas Charts')).client;
  await owner.post('/api/workspaces', {
    name: 'Charts',
    slug: 'charts',
    teamName: 'Charts',
    teamKey: 'CHT',
  });
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  const team = boot.teams[0]!;
  ids.team = team.id;
  ids.done = team.states.find((s) => s.type === 'completed')!.id;
  ids.started = team.states.find((s) => s.type === 'started')!.id;
  ids.project = (await owner.post(`${ws}/projects`, { name: 'Ship', teamIds: [ids.team] })).data.id;
});

afterAll(() => app.close());

describe('timeline', () => {
  it('rebuilds a project day by day from issue history', async () => {
    // Joins the project late, then is finished.
    const late = await create({ title: 'Late', estimate: 3 }, 10);
    await change(late, { projectId: ids.project }, 6);
    await change(late, { stateId: ids.done }, 3);
    // In from the start, re-estimated, then deleted.
    const gone = await create({ title: 'Gone', estimate: 5, projectId: ids.project }, 10);
    await change(gone, { estimate: 8 }, 5);
    expect((await owner.del(`${ws}/issues/${gone}`)).statusCode).toBe(200);
    await backdate(gone, 2);

    const res = await owner.get(`${ws}/insights/timeline?projectId=${ids.project}`);
    expect(res.statusCode).toBe(200);
    const t = res.data as InsightsTimeline;
    // No start date: from the first issue's creation to today.
    expect(t.from).toBe(dayAgo(10));
    expect(t.to).toBe(dayAgo(0));
    expect(t.days).toHaveLength(11);
    const on = (days: number) => t.days.find((d) => d.day === dayAgo(days))!;
    const open = (days: number) => on(days).points.backlog + on(days).points.unstarted;
    expect(open(10)).toBe(5);
    expect(open(6)).toBe(8);
    expect(open(5)).toBe(11);
    expect(on(3).points.completed).toBe(3);
    expect(open(3)).toBe(8);
    expect(open(2)).toBe(0);
    expect(on(0).issues).toMatchObject({ completed: 1, unstarted: 0, backlog: 0 });
  });

  it('takes a range and a scope, and refuses two scopes', async () => {
    const t = (
      await owner.get(
        `${ws}/insights/timeline?teamId=${ids.team}&from=${dayAgo(4)}&to=${dayAgo(1)}`,
      )
    ).data as InsightsTimeline;
    expect(t.days.map((d) => d.day)).toEqual([dayAgo(4), dayAgo(3), dayAgo(2), dayAgo(1)]);
    // The team holds both issues until one is deleted.
    expect(Object.values(t.days[0]!.issues).reduce((a, b) => a + b)).toBe(2);
    expect(Object.values(t.days[3]!.issues).reduce((a, b) => a + b)).toBe(1);
    expect(
      (await owner.get(`${ws}/insights/timeline?teamId=${ids.team}&projectId=${ids.project}`))
        .statusCode,
    ).toBe(400);
    // The workspace by default: the last 12 weeks.
    expect((await owner.get(`${ws}/insights/timeline`)).data.days).toHaveLength(84);
  });
});

describe('velocity', () => {
  it('counts what each cycle committed to and completed, from history', async () => {
    const cycle = async (from: number, to: number) =>
      (
        await owner.post(`${ws}/teams/${ids.team}/cycles`, {
          startsAt: dayAgo(from),
          endsAt: dayAgo(to),
        })
      ).data.id as string;
    ids.c1 = await cycle(20, 14);
    ids.c2 = await cycle(13, 7);
    ids.c3 = await cycle(6, -1);

    const planned = await create({ title: 'Planned', estimate: 2, cycleId: ids.c1 }, 21);
    await change(planned, { stateId: ids.done }, 16);
    // Added mid-cycle and done: completed, not committed.
    const added = await create({ title: 'Added', estimate: 3 }, 21);
    await change(added, { cycleId: ids.c1 }, 17);
    await change(added, { stateId: ids.done }, 15);
    // Committed to cycle 2, rolled over to cycle 3 unfinished.
    const slipped = await create({ title: 'Slipped', estimate: 5, cycleId: ids.c2 }, 14);
    await change(slipped, { cycleId: ids.c3 }, 6);
    await change(slipped, { stateId: ids.started }, 1);

    const v = (await owner.get(`${ws}/insights/velocity?teamId=${ids.team}`)).data as Velocity;
    expect(v.cycles.map((c) => c.cycleId)).toEqual([ids.c1, ids.c2, ids.c3]);
    const [c1, c2, c3] = v.cycles;
    expect(c1).toMatchObject({
      current: false,
      committed: { issues: 1, points: 2 },
      completed: { issues: 2, points: 5 },
    });
    expect(c2).toMatchObject({
      current: false,
      committed: { issues: 1, points: 5 },
      completed: { issues: 0, points: 0 },
    });
    expect(c3).toMatchObject({ current: true, committed: { issues: 1, points: 5 } });
    expect(v.average).toEqual({ issues: 1, points: 2.5 });

    // The cycle's own burn-up: scope grows on the day work was added.
    const t = (await owner.get(`${ws}/insights/timeline?cycleId=${ids.c1}`))
      .data as InsightsTimeline;
    expect(t.from).toBe(dayAgo(20));
    expect(t.to).toBe(dayAgo(14));
    const scope = t.days.map((d) => Object.values(d.points).reduce((a, b) => a + b));
    expect(scope).toEqual([2, 2, 2, 5, 5, 5, 5]);
  });
});

describe('issueTimeline', () => {
  const base: ReplayIssue = {
    id: 'i',
    createdAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    type: 'completed',
    teamId: 't',
    projectId: null,
    cycleId: null,
    estimate: null,
  };
  const at = (iso: string) => Date.parse(iso);

  it('dates statuses from timestamps when history has none (imports)', () => {
    const tl = issueTimeline(
      { ...base, startedAt: '2026-01-03T00:00:00Z', completedAt: '2026-01-05T00:00:00Z' },
      [],
      () => undefined,
    );
    const types = snapshotsAt(tl, [
      at('2025-12-31T00:00:00Z'),
      at('2026-01-02T00:00:00Z'),
      at('2026-01-04T00:00:00Z'),
      at('2026-01-06T00:00:00Z'),
    ]).map((s) => s?.type ?? null);
    expect(types).toEqual([null, 'unstarted', 'started', 'completed']);
  });

  it('starts each field from its first change', () => {
    const tl = issueTimeline(
      { ...base, projectId: 'p2' },
      [
        {
          createdAt: '2026-01-02T00:00:00Z',
          changes: [{ field: 'project', from: 'p1', to: 'p2' }],
        },
        { createdAt: '2026-01-03T00:00:00Z', changes: [{ field: 'state', from: 's1', to: 's2' }] },
      ],
      (id) => (id === 's2' ? 'completed' : 'backlog'),
    );
    const [a, b, c] = snapshotsAt(tl, [
      at('2026-01-01T12:00:00Z'),
      at('2026-01-02T12:00:00Z'),
      at('2026-01-03T12:00:00Z'),
    ]);
    expect([a!.projectId, a!.type]).toEqual(['p1', 'backlog']);
    expect([b!.projectId, b!.type]).toEqual(['p2', 'backlog']);
    expect(c!.type).toBe('completed');
  });
});
