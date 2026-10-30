import type { Bootstrap, Cycle, HistoryEntry, Issue, IssueTemplate, Team } from '@ordo/shared';
import { dayInZone } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cycles, issues } from '../src/db/schema.ts';
import { computeAccess } from '../src/services/access.ts';
import { autoArchive, runAutomation } from '../src/services/automation.ts';
import { automateCycles, cycleForStartedIssue } from '../src/services/cycle-automation.ts';
import { callMcpTool } from '../src/services/mcp.ts';
import { runRecurring } from '../src/services/recurring.ts';
import { announceSlaBreaches } from '../src/services/sla.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
const ws = '/api/w/sched';
let boot: Bootstrap;
let eng: Team;
let ops: Team;

const get = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as Issue;
const state = (team: Team, type: string) => team.states.find((s) => s.type === type)!.id;
const make = async (team: Team, title: string, extra: object = {}) =>
  (await owner.post(`${ws}/issues`, { teamId: team.id, title, ...extra })).data as Issue;
const teamCycles = async (team: Team) =>
  ((await owner.get(`${ws}/cycles`)).data as Cycle[]).filter((c) => c.teamId === team.id);

/**
 * Makes writes to `table` fail when `condition` holds (on `new`), the way a broken row or a
 * constraint would in production. Returns a function that removes the trigger again.
 */
async function failWhen(table: string, op: 'insert' | 'update', condition: string) {
  const name = `fail_${table}_${Math.random().toString(36).slice(2, 8)}`;
  await app.db.execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $$
      begin
        if ${condition} then raise exception 'injected failure'; end if;
        return new;
      end $$`),
  );
  await app.db.execute(
    sql.raw(`create trigger ${name} before ${op} on ${table}
      for each row execute function ${name}()`),
  );
  return async () => {
    await app.db.execute(sql.raw(`drop trigger ${name} on ${table}`));
    await app.db.execute(sql.raw(`drop function ${name}()`));
  };
}

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Sched',
    slug: 'sched',
    teamName: 'Eng',
    teamKey: 'ENG',
  });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  eng = boot.teams[0]!;
  ops = (await owner.post(`${ws}/teams`, { name: 'Ops', key: 'OPS' })).data as Team;
});

afterAll(() => app.close());

describe('one failure does not stop the rest', () => {
  it('cycle automation handles each team on its own', async () => {
    for (const team of [eng, ops])
      await owner.patch(`${ws}/teams/${team.id}`, {
        cycleAutomation: { enabled: true, weeks: 2, startDay: 1, upcoming: 1 },
      });
    const undo = await failWhen('cycles', 'insert', `new.team_id = '${eng.id}'`);
    try {
      await expect(automateCycles(app)).resolves.toBeUndefined();
    } finally {
      await undo();
    }
    expect(await teamCycles(eng)).toHaveLength(0);
    expect(await teamCycles(ops)).toHaveLength(1);
    // The next run catches the failed team up.
    await automateCycles(app);
    expect(await teamCycles(eng)).toHaveLength(1);
  });

  it('SLA checks handle each issue on its own', async () => {
    const a = await make(eng, 'Late A', { stateId: state(eng, 'unstarted') });
    const b = await make(ops, 'Late B', { stateId: state(ops, 'unstarted') });
    for (const id of [a.id, b.id])
      await app.db
        .update(issues)
        .set({ slaBreachesAt: sql`now() - interval '1 hour'` })
        .where(eq(issues.id, id));
    const undo = await failWhen(
      'issues',
      'update',
      `new.id = '${a.id}' and new.sla_notified_at is not null`,
    );
    try {
      await announceSlaBreaches(app);
    } finally {
      await undo();
    }
    const notified = async (id: string) =>
      (await app.db.select().from(issues).where(eq(issues.id, id)))[0]!.slaNotifiedAt;
    expect(await notified(a.id)).toBeNull();
    expect(await notified(b.id)).not.toBeNull();
    await announceSlaBreaches(app);
    expect(await notified(a.id)).not.toBeNull();
  });

  it('auto-archive handles each team on its own', async () => {
    const old = async (team: Team) => {
      const issue = await make(team, `Old in ${team.key}`, { stateId: state(team, 'completed') });
      await app.db
        .update(issues)
        .set({ completedAt: sql`now() - interval '4 months'` })
        .where(eq(issues.id, issue.id));
      return issue.id;
    };
    const a = await old(eng);
    const b = await old(ops);
    for (const team of [eng, ops])
      await owner.patch(`${ws}/teams/${team.id}`, { autoArchiveMonths: 3 });
    const undo = await failWhen(
      'issues',
      'update',
      `new.team_id = '${eng.id}' and new.archived_at is not null`,
    );
    try {
      await autoArchive(app);
    } finally {
      await undo();
    }
    expect((await get(a)).archivedAt).toBeNull();
    expect((await get(b)).archivedAt).not.toBeNull();
    await autoArchive(app);
    expect((await get(a)).archivedAt).not.toBeNull();
    for (const team of [eng, ops])
      await owner.patch(`${ws}/teams/${team.id}`, { autoArchiveMonths: null });
  });

  it('recurring issues handle each schedule on its own', async () => {
    const template = (
      await owner.post(`${ws}/templates`, { name: 'Standup', title: 'Standup notes' })
    ).data as IssueTemplate;
    for (const team of [eng, ops])
      await owner.post(`${ws}/recurring`, {
        templateId: template.id,
        teamId: team.id,
        every: 1,
        unit: 'week',
        nextOn: '2026-11-02',
      });
    const standups = async (team: Team) =>
      (
        (await owner.post(`${ws}/issues/query`, { filter: { teamId: team.id } })).data as Issue[]
      ).filter((i) => i.title === 'Standup notes');
    const undo = await failWhen('issues', 'insert', `new.team_id = '${eng.id}'`);
    try {
      await runRecurring(app, '2026-11-02');
    } finally {
      await undo();
    }
    expect(await standups(eng)).toHaveLength(0);
    expect(await standups(ops)).toHaveLength(1);
    await runRecurring(app, '2026-11-02');
    expect(await standups(eng)).toHaveLength(1);
    expect(await standups(ops)).toHaveLength(1);
  });
});

describe('trash', () => {
  it('keeps the first trash date when an issue is trashed again', async () => {
    const issue = await make(eng, 'Trash me');
    await owner.del(`${ws}/issues/${issue.id}`);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await app.db.update(issues).set({ deletedAt: weekAgo }).where(eq(issues.id, issue.id));
    expect((await owner.del(`${ws}/issues/${issue.id}`)).statusCode).toBe(200);
    expect((await owner.post(`${ws}/issues/batch-delete`, { ids: [issue.id] })).statusCode).toBe(
      200,
    );
    const [row] = await app.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(Date.parse(row!.deletedAt!)).toBe(Date.parse(weekAgo));
    const history = (await owner.get(`${ws}/issues/${issue.id}/history`)).data as HistoryEntry[];
    expect(history.filter((h) => h.changes.some((c) => c.field === 'deleted'))).toHaveLength(1);
  });
});

describe('triage', () => {
  it('moves waiting issues to the default status when a team turns triage off', async () => {
    const team = (await owner.patch(`${ws}/teams/${ops.id}`, { triageEnabled: true })).data as Team;
    const waiting = await make(team, 'Needs a look', { stateId: state(team, 'triage') });
    const trashed = await make(team, 'Trashed in triage', { stateId: state(team, 'triage') });
    await owner.del(`${ws}/issues/${trashed.id}`);
    const off = (await owner.patch(`${ws}/teams/${team.id}`, { triageEnabled: false }))
      .data as Team;
    const expected = off.defaultStateId ?? state(off, 'backlog');
    expect((await get(waiting.id)).stateId).toBe(expected);
  });
});

describe('cycle automation and time zones', () => {
  // 12:00 UTC on Sunday 8 November is already Monday 9 November in Kiritimati (UTC+14).
  const at = new Date('2026-11-08T12:00:00Z');
  const zone = 'Pacific/Kiritimati';
  let team: Team;

  beforeAll(async () => {
    team = (await owner.post(`${ws}/teams`, { name: 'Zone', key: 'ZON' })).data as Team;
    expect(
      (await owner.patch(`${ws}/`, { settings: { timezone: 'Mars/Olympus' } })).statusCode,
    ).toBe(400);
    expect((await owner.patch(`${ws}/`, { settings: { timezone: zone } })).statusCode).toBe(200);
  });

  afterAll(async () => {
    await owner.patch(`${ws}/`, { settings: { timezone: null } });
  });

  it('plans and closes cycles by the day in the workspace time zone', async () => {
    await owner.patch(`${ws}/teams/${team.id}`, {
      cycleAutomation: { enabled: true, weeks: 2, startDay: 1, upcoming: 1 },
    });
    await automateCycles(app, at);
    // It's Monday the 9th there: the cycle starting today is running, and one more is planned.
    expect((await teamCycles(team)).map((c) => `${c.startsAt}→${c.endsAt}`)).toEqual([
      '2026-11-09→2026-11-23',
      '2026-11-23→2026-12-07',
    ]);
  });

  it('puts started work into the cycle that is active there', async () => {
    await owner.patch(`${ws}/teams/${team.id}`, { cycleAutomation: { addStarted: true } });
    const [first] = await teamCycles(team);
    const active = await runAutomation(app, boot.workspace.id, (ctx) =>
      cycleForStartedIssue(ctx, team.id, at),
    );
    expect(active).toBe(first!.id);
  });

  it('closes cycles that end today there when automation is turned on', async () => {
    const other = (await owner.post(`${ws}/teams`, { name: 'Late', key: 'LAT' })).data as Team;
    const today = dayInZone(zone);
    const ending = (
      await owner.post(`${ws}/teams/${other.id}/cycles`, {
        startsAt: '2026-01-05',
        endsAt: today,
      })
    ).data as Cycle;
    await owner.patch(`${ws}/teams/${other.id}`, { cycleAutomation: { enabled: true } });
    const [row] = await app.db.select().from(cycles).where(eq(cycles.id, ending.id));
    expect(row!.completedAt).not.toBeNull();
  });

  it('agents see the same current cycle as automation', async () => {
    const access = await computeAccess(app.db, boot.members[0]!.id, boot.workspace.id, 'owner');
    const caller = { app, access, workspace: boot.workspace, run: () => Promise.reject() };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    try {
      const listed = (await callMcpTool(caller, 'list_cycles', { team: 'ZON' })) as {
        startsAt: string;
        current: boolean;
      }[];
      // Still the 8th in UTC, but the cycle starting on the 9th is the one running there.
      expect(listed.find((c) => c.current)?.startsAt).toBe('2026-11-09');
    } finally {
      vi.useRealTimers();
    }
  });
});
