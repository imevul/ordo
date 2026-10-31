import type { Bootstrap, Issue, IssueTemplate, RecurringIssue } from '@ordo/shared';
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
    expect((await member.del(`${ws}/recurring/${hidden.id}`)).statusCode).toBe(404);
    expect((await member.del(`${ws}/recurring/${ids.schedule}`)).statusCode).toBe(200);
  });
});
