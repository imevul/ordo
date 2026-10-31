import type {
  AgentRun,
  AgentRunContext,
  Bootstrap,
  Issue,
  IssueTemplate,
  RecurringIssue,
} from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recurringIssues } from '../src/db/schema.ts';
import { advance, runRecurring } from '../src/services/recurring.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let guest: Client;
const ws = '/api/w/rec';
const ids: Record<string, string> = {};

const noonUtc = (day: string) => new Date(`${day}T12:00:00Z`);

const teamIssues = async (teamId: string) =>
  ((await owner.post(`${ws}/issues/query`, { filter: { teamId } })).data as Issue[]).map(
    (i) => i.title,
  );

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Rec',
    slug: 'rec',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: await invite('member') })).client;
  guest = (await signup(app, 'Gus Guest', { inviteToken: await invite('guest') })).client;
  ids.member = (await member.get('/api/auth/me')).data.id;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  ids.pub = boot.teams[0]!.id;
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })
  ).data.id;
  ids.bug = (await owner.post(`${ws}/labels`, { name: 'Chore', color: '#ef4444' })).data.id;
  ids.weekly = (
    (
      await member.post(`${ws}/templates`, {
        name: 'Weekly sync',
        title: 'Weekly sync notes',
        description: '## Agenda',
        priority: 3,
        labelIds: [ids.bug],
        assigneeId: ids.member,
      })
    ).data as IssueTemplate
  ).id;
});

afterAll(() => app.close());

describe('advance', () => {
  it('steps days, weeks and months, keeping month ends sane', () => {
    expect(advance('2026-11-02', 3, 'day')).toBe('2026-11-05');
    expect(advance('2026-11-02', 2, 'week')).toBe('2026-11-16');
    expect(advance('2026-01-31', 1, 'month')).toBe('2026-02-28');
    expect(advance('2026-11-15', 3, 'month')).toBe('2027-02-15');
  });
});

describe('recurring issues', () => {
  it('create the issue when due, once, then wait for the next date', async () => {
    const res = await member.post(`${ws}/recurring`, {
      templateId: ids.weekly,
      teamId: ids.pub,
      every: 1,
      unit: 'week',
      nextOn: '2026-11-02',
    });
    expect(res.statusCode).toBe(200);
    ids.schedule = (res.data as RecurringIssue).id;
    await runRecurring(app, noonUtc('2026-11-01'));
    expect(await teamIssues(ids.pub)).toEqual([]);
    await runRecurring(app, noonUtc('2026-11-02'));
    const [made] = (await owner.post(`${ws}/issues/query`, { filter: { teamId: ids.pub } }))
      .data as Issue[];
    expect(made).toMatchObject({
      title: 'Weekly sync notes',
      description: '## Agenda',
      priority: 3,
      labelIds: [ids.bug],
      assigneeId: ids.member,
    });
    await runRecurring(app, noonUtc('2026-11-02'));
    expect(await teamIssues(ids.pub)).toHaveLength(1);
    const [row] = await app.db
      .select()
      .from(recurringIssues)
      .where(eq(recurringIssues.id, ids.schedule));
    expect(row).toMatchObject({ nextOn: '2026-11-09', lastIssueId: made!.id });
  });

  it("don't pile up missed runs", async () => {
    await member.patch(`${ws}/recurring/${ids.schedule}`, { nextOn: '2026-09-07' });
    await runRecurring(app, noonUtc('2026-11-04'));
    expect(await teamIssues(ids.pub)).toHaveLength(2);
    const [row] = await app.db
      .select()
      .from(recurringIssues)
      .where(eq(recurringIssues.id, ids.schedule));
    expect(row!.nextOn).toBe('2026-11-09');
  });

  it('skip paused schedules', async () => {
    await member.patch(`${ws}/recurring/${ids.schedule}`, { paused: true, nextOn: '2026-11-04' });
    await runRecurring(app, noonUtc('2026-11-04'));
    expect(await teamIssues(ids.pub)).toHaveLength(2);
  });

  it('still create the issue when the template has gone stale for the team', async () => {
    // The template's assignee can't see the private team: the issue is made without them.
    await owner.post(`${ws}/recurring`, {
      templateId: ids.weekly,
      teamId: ids.prv,
      every: 1,
      unit: 'month',
      nextOn: '2026-11-04',
    });
    await runRecurring(app, noonUtc('2026-11-04'));
    const made = (await owner.post(`${ws}/issues/query`, { filter: { teamId: ids.prv } }))
      .data as Issue[];
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ title: 'Weekly sync notes', assigneeId: null });
  });

  it("fire on the workspace's day, not UTC's", async () => {
    await owner.patch(`${ws}/`, { settings: { timezone: 'America/Los_Angeles' } });
    const res = await owner.post(`${ws}/recurring`, {
      templateId: ids.weekly,
      teamId: ids.prv,
      every: 1,
      unit: 'week',
      nextOn: '2026-11-09',
    });
    const id = (res.data as RecurringIssue).id;
    const nextOn = async () =>
      (await app.db.select().from(recurringIssues).where(eq(recurringIssues.id, id)))[0]!.nextOn;
    // Monday 03:00 UTC is still Sunday afternoon in Los Angeles.
    await runRecurring(app, new Date('2026-11-09T03:00:00Z'));
    expect(await nextOn()).toBe('2026-11-09');
    await runRecurring(app, new Date('2026-11-09T09:00:00Z'));
    expect(await nextOn()).toBe('2026-11-16');
    await owner.patch(`${ws}/`, { settings: { timezone: null } });
    await owner.del(`${ws}/recurring/${id}`);
  });

  it('only fall back to a bare issue when the template is stale', async () => {
    const res = await owner.post(`${ws}/recurring`, {
      templateId: ids.weekly,
      teamId: ids.pub,
      every: 1,
      unit: 'day',
      nextOn: '2026-11-04',
    });
    const id = (res.data as RecurringIssue).id;
    // A failure that has nothing to do with the template, hitting only the full issue (the bare
    // one has no priority): the schedule must fail, not quietly make a bare issue.
    await app.db.execute(sql`
      create function test_fail_insert() returns trigger language plpgsql as
        $$ begin raise exception 'disk on fire'; end $$`);
    await app.db.execute(sql`
      create trigger test_fail_insert before insert on issues
        for each row when (new.priority = 3) execute function test_fail_insert()`);
    const before = await teamIssues(ids.pub);
    try {
      await runRecurring(app, noonUtc('2026-11-05'));
    } finally {
      await app.db.execute(sql`drop trigger test_fail_insert on issues`);
      await app.db.execute(sql`drop function test_fail_insert`);
    }
    expect(await teamIssues(ids.pub)).toEqual(before);
    const [row] = await app.db.select().from(recurringIssues).where(eq(recurringIssues.id, id));
    expect(row!.nextOn).toBe('2026-11-04');
    await owner.del(`${ws}/recurring/${id}`);
  });

  it('follow team access and template rules', async () => {
    const teamTemplate = (
      await owner.post(`${ws}/templates`, { name: 'Pub only', teamId: ids.pub })
    ).data as IssueTemplate;
    const wrongTeam = await owner.post(`${ws}/recurring`, {
      templateId: teamTemplate.id,
      teamId: ids.prv,
      every: 1,
      unit: 'day',
      nextOn: '2026-11-04',
    });
    expect(wrongTeam.statusCode).toBe(400);
    expect(
      (
        await guest.post(`${ws}/recurring`, {
          templateId: ids.weekly,
          teamId: ids.pub,
          every: 1,
          unit: 'day',
          nextOn: '2026-11-04',
        })
      ).statusCode,
    ).toBe(403);
    const mine = ((await member.get(`${ws}/bootstrap`)).data as Bootstrap).recurring;
    expect(mine.map((r) => r.teamId)).toEqual([ids.pub]);
    const hidden = ((await owner.get(`${ws}/recurring`)).data as RecurringIssue[]).find(
      (r) => r.teamId === ids.prv,
    )!;
    expect(
      (await member.patch(`${ws}/recurring/${hidden.id}`, { every: 2, paused: true })).statusCode,
    ).toBe(404);
    const [untouched] = await app.db
      .select()
      .from(recurringIssues)
      .where(eq(recurringIssues.id, hidden.id));
    expect(untouched!.every).toBe(hidden.every);
    expect((await member.del(`${ws}/recurring/${hidden.id}`)).statusCode).toBe(404);
    expect((await member.del(`${ws}/recurring/${ids.schedule}`)).statusCode).toBe(200);
  });
});

describe('recurring issues for an agent', () => {
  let agentId: string;
  let token: string;
  let scheduleId: string;
  const claim = async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${ws}/agent/claim?runner=test-host`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { statusCode: res.statusCode, data: res.statusCode === 200 ? res.json() : null } as {
      statusCode: number;
      data: AgentRunContext | null;
    };
  };
  const finish = (runId: string) =>
    app.inject({
      method: 'PATCH',
      url: `${ws}/agent/runs/${runId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'succeeded', summary: 'Checked.' },
    });
  const occurrence = async (day: string) => {
    await runRecurring(app, noonUtc(day));
    const made = (await owner.post(`${ws}/issues/query`, { filter: { teamId: ids.pub } }))
      .data as Issue[];
    const [row] = await app.db
      .select()
      .from(recurringIssues)
      .where(eq(recurringIssues.id, scheduleId));
    const issue = made.find((i) => i.id === row!.lastIssueId)!;
    const runs = (await owner.get(`${ws}/issues/${issue.id}/agent-runs`)).data as AgentRun[];
    return { issue, runs };
  };

  beforeAll(async () => {
    agentId = (await owner.post(`${ws}/agents`, { name: 'Nightly Rec', teamIds: [ids.pub] })).data
      .id;
    token = (await owner.post(`${ws}/agents/${agentId}/keys`, { name: 'k' })).data.token;
    const template = (
      await owner.post(`${ws}/templates`, {
        name: 'Dependency check',
        title: 'Nightly dependency check',
        description: 'Look for outdated dependencies and open a pull request.',
        assigneeId: agentId,
      })
    ).data as IssueTemplate;
    scheduleId = (
      (
        await owner.post(`${ws}/recurring`, {
          templateId: template.id,
          teamId: ids.pub,
          every: 1,
          unit: 'day',
          nextOn: '2026-11-10',
        })
      ).data as RecurringIssue
    ).id;
  });

  it('queue a scheduled run with the description as the task', async () => {
    const { issue, runs } = await occurrence('2026-11-10');
    expect(issue).toMatchObject({ title: 'Nightly dependency check', assigneeId: agentId });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'queued', trigger: 'scheduled', agentId });
    const { data } = await claim();
    expect(data!.issue.id).toBe(issue.id);
    expect(data!.trigger.kind).toBe('scheduled');
    expect(data!.prompt).toContain('Look for outdated dependencies and open a pull request.');
    expect(data!.prompt).toContain('A recurring schedule created this issue');
    expect((await finish(data!.run.id)).statusCode).toBe(200);

    // The next occurrence is a new issue with its own run.
    const next = await occurrence('2026-11-11');
    expect(next.issue.id).not.toBe(issue.id);
    expect(next.runs).toMatchObject([{ status: 'queued', trigger: 'scheduled' }]);
    const again = await claim();
    expect(again.data!.issue.id).toBe(next.issue.id);
    await finish(again.data!.run.id);
  });

  it('hold the run while the agent is paused, then hand it out', async () => {
    const setPause = (until: string | null) =>
      app.db.execute(sql`update agents set paused_until = ${until} where user_id = ${agentId}`);
    await setPause(new Date(Date.now() + 3_600_000).toISOString());
    const { issue, runs } = await occurrence('2026-11-12');
    expect(runs).toMatchObject([{ status: 'queued', trigger: 'scheduled' }]);
    expect((await claim()).statusCode).toBe(204);
    await setPause(null);
    const { data } = await claim();
    expect(data!.issue.id).toBe(issue.id);
    await finish(data!.run.id);
  });

  it('hold the run while agent runs are paused in the workspace', async () => {
    await owner.patch(ws, { settings: { agentRunsPaused: true } });
    const { issue, runs } = await occurrence('2026-11-13');
    expect(runs).toMatchObject([{ status: 'queued', trigger: 'scheduled' }]);
    expect((await claim()).statusCode).toBe(204);
    await owner.patch(ws, { settings: { agentRunsPaused: false } });
    const { data } = await claim();
    expect(data!.issue.id).toBe(issue.id);
    await finish(data!.run.id);
  });

  it("make the issue without a run when the agent can't take it", async () => {
    await owner.patch(`${ws}/agents/${agentId}`, { disabled: true });
    const { issue, runs } = await occurrence('2026-11-14');
    expect(issue.title).toBe('Nightly dependency check');
    expect(runs).toEqual([]);
    await owner.del(`${ws}/recurring/${scheduleId}`);
  });
});
