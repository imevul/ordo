import type { AutomationRule, Bootstrap, HistoryEntry, Issue, Team } from '@ordo/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { automationBot } from '../src/services/automation.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
const ws = '/api/w/autorules';
let team: Team;
const ids: Record<string, string> = {};
const stateId = (name: string) => team.states.find((s) => s.name === name)!.id;

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

const rule = async (body: object) => {
  const res = await owner.post(`${ws}/teams/${team.id}/automation-rules`, body);
  expect(res.statusCode).toBe(200);
  return res.data as AutomationRule;
};
const newIssue = async (title: string, extra: object = {}) =>
  (await member.post(`${ws}/issues`, { teamId: team.id, title, ...extra })).data as Issue;
const get = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as Issue;
const rules = async () =>
  ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!.automationRules;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Rhea Rulemaker')).client;
  await owner.post('/api/workspaces', {
    name: 'Autorules',
    slug: 'autorules',
    teamName: 'Ops',
    teamKey: 'OPS',
  });
  const invite = async () => (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Milo Automember', { inviteToken: await invite() })).client;
  const sec = (await signup(app, 'Sasha Seconcall', { inviteToken: await invite() })).client;
  ids.member = (await member.get('/api/auth/me')).data.id;
  ids.sec = (await sec.get('/api/auth/me')).data.id;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  team = boot.teams[0]!;
  ids.workspace = boot.workspace.id;
  const label = async (name: string) =>
    (await owner.post(`${ws}/labels`, { name, color: '#ef4444' })).data.id as string;
  ids.security = await label('Security');
  ids.ping = await label('Ping');
  ids.pong = await label('Pong');
});

afterAll(() => app.close());

describe('automation rules', () => {
  it('are managed by team admins and checked against the team', async () => {
    const body = {
      name: 'x',
      trigger: { type: 'issue_created' },
      actions: { priority: 1 },
    };
    expect((await member.post(`${ws}/teams/${team.id}/automation-rules`, body)).statusCode).toBe(
      403,
    );
    const bad = (extra: object) =>
      owner.post(`${ws}/teams/${team.id}/automation-rules`, { ...body, ...extra });
    expect((await bad({ trigger: { type: 'whenever' } })).statusCode).toBe(400);
    expect(
      (await bad({ actions: { stateId: '00000000-0000-4000-8000-000000000000' } })).statusCode,
    ).toBe(400);
    // The bot is "me" when rules run, so conditions name people.
    expect((await bad({ conditions: { assigneeIds: ['me'] } })).statusCode).toBe(400);
    expect((await bad({ conditions: { subscribedBy: 'me' } })).statusCode).toBe(400);
    // Conditions beyond the rule editor's subset are refused, not silently dropped.
    for (const conditions of [
      { blocked: true },
      { hasPullRequest: true },
      { estimate: { min: 3 } },
      { dueDate: { range: 'overdue' } },
      { exclude: { priorities: [1] } },
      { or: [{ priorities: [1] }] },
    ]) {
      expect((await bad({ conditions })).statusCode).toBe(400);
    }

    const created = await rule(body);
    expect(created).toMatchObject({ enabled: true, conditions: {}, runCount: 0, lastRunAt: null });
    expect(
      (await member.patch(`${ws}/automation-rules/${created.id}`, { enabled: false })).statusCode,
    ).toBe(403);
    expect((await member.del(`${ws}/automation-rules/${created.id}`)).statusCode).toBe(403);
    const off = await owner.patch(`${ws}/automation-rules/${created.id}`, { enabled: false });
    expect(off.data.enabled).toBe(false);
    expect((await rules()).map((r) => r.id)).toContain(created.id);
    expect((await owner.del(`${ws}/automation-rules/${created.id}`)).statusCode).toBe(200);
    expect(await rules()).toEqual([]);
  });

  it('acts when a label is added, as the Ordo bot, with an activity line naming the rule', async () => {
    const r = await rule({
      name: 'Security is urgent',
      trigger: { type: 'label_added', labelIds: [ids.security] },
      actions: { priority: 1, assigneeId: ids.sec },
    });
    const issue = await newIssue('Leaky token');
    await member.patch(`${ws}/issues/${issue.id}`, { addLabelIds: [ids.ping] });
    await settle();
    expect((await get(issue.id)).priority).toBe(0);

    await member.patch(`${ws}/issues/${issue.id}`, { addLabelIds: [ids.security] });
    await settle();
    const after = await get(issue.id);
    expect(after).toMatchObject({ priority: 1, assigneeId: ids.sec });
    const bot = await automationBot(app.db, ids.workspace);
    const history = (await owner.get(`${ws}/issues/${issue.id}/history`)).data as HistoryEntry[];
    const byRule = history.find((h) => h.changes.some((c) => c.field === 'automation'))!;
    expect(byRule.actorId).toBe(bot);
    expect(byRule.changes).toContainEqual({
      field: 'automation',
      from: null,
      to: { id: r.id, name: 'Security is urgent' },
    });
    expect(byRule.changes.map((c) => c.field)).toEqual(
      expect.arrayContaining(['priority', 'assignee']),
    );
    const [stored] = (await rules()).filter((x) => x.id === r.id);
    expect(stored).toMatchObject({ runCount: 1 });
    expect(stored!.lastRunAt).not.toBeNull();
    await owner.del(`${ws}/automation-rules/${r.id}`);
  });

  it('moves a parent to Done when all its sub-issues are done', async () => {
    const r = await rule({
      name: 'Close finished parents',
      trigger: { type: 'sub_issues_completed' },
      actions: { stateId: stateId('Done') },
    });
    const parent = await newIssue('Epic');
    const a = await newIssue('Part A', { parentId: parent.id });
    const b = await newIssue('Part B', { parentId: parent.id });
    await member.patch(`${ws}/issues/${a.id}`, { stateId: stateId('Done') });
    await settle();
    expect((await get(parent.id)).stateId).not.toBe(stateId('Done'));
    // Canceled counts as finished, as long as something was done.
    await member.patch(`${ws}/issues/${b.id}`, { stateId: stateId('Canceled') });
    await settle();
    expect((await get(parent.id)).stateId).toBe(stateId('Done'));
    await owner.del(`${ws}/automation-rules/${r.id}`);
  });

  it('checks conditions from the filter model when the rule runs', async () => {
    const r = await rule({
      name: 'Review goes to Sasha, if it matters',
      trigger: { type: 'status_changed', stateIds: [stateId('In Review')] },
      conditions: { priorities: [1, 2] },
      actions: { assigneeId: ids.sec, comment: 'Over to you.' },
    });
    const low = await newIssue('Typo', { priority: 4 });
    const high = await newIssue('Outage', { priority: 1 });
    for (const i of [low, high])
      await member.patch(`${ws}/issues/${i.id}`, { stateId: stateId('In Progress') });
    await settle();
    expect((await get(high.id)).assigneeId).not.toBe(ids.sec);
    for (const i of [low, high])
      await member.patch(`${ws}/issues/${i.id}`, { stateId: stateId('In Review') });
    await settle();
    expect((await get(low.id)).assigneeId).not.toBe(ids.sec);
    expect((await get(high.id)).assigneeId).toBe(ids.sec);
    const comments = (await owner.get(`${ws}/issues/${high.id}/comments`)).data as {
      body: string;
    }[];
    expect(comments.map((c) => c.body)).toEqual(['Over to you.']);
    await owner.del(`${ws}/automation-rules/${r.id}`);
  });

  it('runs on new issues, but not disabled rules', async () => {
    const on = await rule({
      name: 'Crashes are high',
      trigger: { type: 'issue_created' },
      conditions: { q: 'crash' },
      actions: { priority: 2 },
    });
    const off = await rule({
      name: 'Off',
      enabled: false,
      trigger: { type: 'issue_created' },
      actions: { addLabelIds: [ids.ping] },
    });
    const crash = await newIssue('App crash on start');
    const other = await newIssue('Dark mode');
    await settle();
    expect((await get(crash.id)).priority).toBe(2);
    expect((await get(other.id)).priority).toBe(0);
    expect((await get(crash.id)).labelIds).toEqual([]);
    await owner.del(`${ws}/automation-rules/${on.id}`);
    await owner.del(`${ws}/automation-rules/${off.id}`);
  });

  it('stops rules that would set each other off forever', async () => {
    const ping = await rule({
      name: 'Ping to pong',
      trigger: { type: 'label_added', labelIds: [ids.ping] },
      actions: { removeLabelIds: [ids.ping], addLabelIds: [ids.pong] },
    });
    const pong = await rule({
      name: 'Pong to ping',
      trigger: { type: 'label_added', labelIds: [ids.pong] },
      actions: { removeLabelIds: [ids.pong], addLabelIds: [ids.ping] },
    });
    const issue = await newIssue('Ball');
    await member.patch(`${ws}/issues/${issue.id}`, { addLabelIds: [ids.ping] });
    await settle(8);
    // Ping → pong → ping, then "Ping to pong" has already acted in this chain.
    expect((await get(issue.id)).labelIds).toEqual([ids.ping]);
    const runs = Object.fromEntries((await rules()).map((r) => [r.id, r.runCount]));
    expect(runs).toEqual({ [ping.id]: 1, [pong.id]: 1 });
    const [{ count }] = (await app.db.execute<{ count: number }>(
      sql`select count(*)::int as count from jobs where name like 'automations.%' and status = 'pending'`,
    )) as unknown as [{ count: number }];
    expect(count).toBe(0);
  });
});
