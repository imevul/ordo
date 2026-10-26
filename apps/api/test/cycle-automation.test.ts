import type { Bootstrap, Cycle, HistoryEntry, Issue, Team } from '@ordo/shared';
import { cycleAutomationOf } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cycles, teams } from '../src/db/schema.ts';
import { automationBot, runAutomation } from '../src/services/automation.ts';
import {
  addDays,
  automateCycles,
  automateTeamCycles,
  isoDay,
  nextWeekday,
} from '../src/services/cycle-automation.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
const ws = '/api/w/cyc';
let boot: Bootstrap;
let team: Team;

const teamCycles = async () =>
  ((await owner.get(`${ws}/cycles`)).data as Cycle[])
    .filter((c) => c.teamId === team.id)
    .map((c) => `${c.startsAt}→${c.endsAt}`);
const run = async (today: string) => {
  const [row] = await app.db.select().from(teams).where(eq(teams.id, team.id));
  await runAutomation(app, boot.workspace.id, (ctx) =>
    automateTeamCycles(ctx, team.id, cycleAutomationOf(row!.cycleAutomation), today),
  );
};

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Cyc',
    slug: 'cyc',
    teamName: 'Eng',
    teamKey: 'ENG',
  });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  team = boot.teams[0]!;
});

afterAll(() => app.close());

describe('date helpers', () => {
  it('finds weekdays and adds days across months', () => {
    expect(nextWeekday('2026-11-04', 1)).toBe('2026-11-09'); // Wednesday → Monday
    expect(nextWeekday('2026-11-09', 1)).toBe('2026-11-09');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
  });
});

describe('cycle automation', () => {
  it('plans cycles ahead from the next start day, and only once', async () => {
    const res = await owner.patch(`${ws}/teams/${team.id}`, {
      cycleAutomation: { enabled: true, weeks: 2, startDay: 1, upcoming: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.data as Team).cycleAutomation).toMatchObject({ enabled: true, rollOver: true });
    await run('2026-11-04');
    expect(await teamCycles()).toEqual(['2026-11-09→2026-11-23', '2026-11-23→2026-12-07']);
    await run('2026-11-04');
    expect(await teamCycles()).toHaveLength(2);
    await run('2026-11-10'); // the first cycle is running: one more goes on the plan
    expect((await teamCycles()).at(-1)).toBe('2026-12-07→2026-12-21');
  });

  it('respects a cooldown between cycles', async () => {
    await owner.patch(`${ws}/teams/${team.id}`, { cycleAutomation: { cooldownWeeks: 1 } });
    await run('2026-11-24');
    expect((await teamCycles()).at(-1)).toBe('2026-12-28→2027-01-11');
    await owner.patch(`${ws}/teams/${team.id}`, { cycleAutomation: { cooldownWeeks: 0 } });
  });

  it('rolls unfinished issues over to the next cycle, as the Ordo bot', async () => {
    const all = (await owner.get(`${ws}/cycles`)).data as Cycle[];
    const second = all.find((c) => c.startsAt === '2026-11-23')!;
    const third = all.find((c) => c.startsAt === '2026-12-07')!;
    const todo = team.states.find((s) => s.type === 'unstarted')!.id;
    const done = team.states.find((s) => s.type === 'completed')!.id;
    const open = (
      await owner.post(`${ws}/issues`, {
        teamId: team.id,
        title: 'Open',
        stateId: todo,
        cycleId: second.id,
      })
    ).data as Issue;
    const closed = (
      await owner.post(`${ws}/issues`, {
        teamId: team.id,
        title: 'Done',
        stateId: done,
        cycleId: second.id,
      })
    ).data as Issue;
    await run('2026-12-07');
    expect(((await owner.get(`${ws}/issues/${open.id}`)).data as Issue).cycleId).toBe(third.id);
    expect(((await owner.get(`${ws}/issues/${closed.id}`)).data as Issue).cycleId).toBe(second.id);
    const [row] = await app.db.select().from(cycles).where(eq(cycles.id, second.id));
    expect(row!.completedAt).not.toBeNull();
    const history = (await owner.get(`${ws}/issues/${open.id}/history`)).data as HistoryEntry[];
    expect(history.at(-1)?.actorId).toBe(await automationBot(app.db, boot.workspace.id));
    // Closed cycles stay closed: running again moves nothing back.
    await run('2026-12-08');
    expect(((await owner.get(`${ws}/issues/${open.id}`)).data as Issue).cycleId).toBe(third.id);
  });

  it('puts started work into the active cycle when asked to', async () => {
    const today = isoDay(new Date());
    const active = (
      await owner.post(`${ws}/teams/${team.id}/cycles`, {
        startsAt: addDays(today, -3),
        endsAt: addDays(today, 4),
      })
    ).data as Cycle;
    const started = team.states.find((s) => s.type === 'started')!.id;
    const issue = (await owner.post(`${ws}/issues`, { teamId: team.id, title: 'Work' }))
      .data as Issue;
    await owner.patch(`${ws}/issues/${issue.id}`, { stateId: started });
    expect(((await owner.get(`${ws}/issues/${issue.id}`)).data as Issue).cycleId).toBeNull();

    await owner.patch(`${ws}/teams/${team.id}`, { cycleAutomation: { addStarted: true } });
    const later = (await owner.post(`${ws}/issues`, { teamId: team.id, title: 'More' }))
      .data as Issue;
    await owner.patch(`${ws}/issues/${later.id}`, { stateId: started });
    expect(((await owner.get(`${ws}/issues/${later.id}`)).data as Issue).cycleId).toBe(active.id);
    const born = (
      await owner.post(`${ws}/issues`, { teamId: team.id, title: 'Born started', stateId: started })
    ).data as Issue;
    expect(born.cycleId).toBe(active.id);
  });

  it('leaves cycles that ended before automation was turned on alone', async () => {
    const other = (await owner.post(`${ws}/teams`, { name: 'Ops', key: 'OPS' })).data as Team;
    const past = (
      await owner.post(`${ws}/teams/${other.id}/cycles`, {
        startsAt: '2026-01-05',
        endsAt: '2026-01-19',
      })
    ).data as Cycle;
    const todo = other.states.find((s) => s.type === 'unstarted')!.id;
    const issue = (
      await owner.post(`${ws}/issues`, {
        teamId: other.id,
        title: 'Old',
        stateId: todo,
        cycleId: past.id,
      })
    ).data as Issue;
    await owner.patch(`${ws}/teams/${other.id}`, { cycleAutomation: { enabled: true } });
    await automateCycles(app);
    expect(((await owner.get(`${ws}/issues/${issue.id}`)).data as Issue).cycleId).toBe(past.id);
    const planned = ((await owner.get(`${ws}/cycles`)).data as Cycle[]).filter(
      (c) => c.teamId === other.id,
    );
    expect(planned.filter((c) => c.startsAt > isoDay(new Date()))).toHaveLength(2);
  });
});
