import type { Bootstrap, HistoryEntry, Issue, Team, TriageRule } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.ts';
import { automationBot } from '../src/services/automation.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
const ws = '/api/w/tri';
let team: Team;
let boot: Bootstrap;
const ids: Record<string, string> = {};

const file = async (title: string, extra: object = {}) =>
  (
    await member.post(`${ws}/issues`, {
      teamId: team.id,
      title,
      stateId: ids.triage,
      ...extra,
    })
  ).data as Issue;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Tri',
    slug: 'tri',
    teamName: 'Sup',
    teamKey: 'SUP',
  });
  const invite = async () => (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: await invite() })).client;
  const ada = (await signup(app, 'Ada Lovelace', { inviteToken: await invite() })).client;
  const alan = (await signup(app, 'Alan Turing', { inviteToken: await invite() })).client;
  ids.owner = (await owner.get('/api/auth/me')).data.id;
  ids.ada = (await ada.get('/api/auth/me')).data.id;
  ids.alan = (await alan.get('/api/auth/me')).data.id;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  team = boot.teams[0]!;
  // Take the bot's default username before the bot exists, so creating it has to pick another.
  ids.squatted = `ordo-${boot.workspace.id.slice(0, 8)}`;
  expect((await member.patch('/api/me', { username: ids.squatted })).statusCode).toBe(200);
  team = (await owner.patch(`${ws}/teams/${team.id}`, { triageEnabled: true })).data as Team;
  ids.triage = team.states.find((s) => s.type === 'triage')!.id;
  ids.todo = team.states.find((s) => s.type === 'unstarted')!.id;
  ids.bug = (await owner.post(`${ws}/labels`, { name: 'Bug', color: '#ef4444' })).data.id;
});

afterAll(() => app.close());

describe('triage rules', () => {
  it('are managed by team admins and checked against the team', async () => {
    const denied = await member.post(`${ws}/teams/${team.id}/triage-rules`, {
      name: 'x',
      conditions: {},
      actions: {},
    });
    expect(denied.statusCode).toBe(403);
    const badState = await owner.post(`${ws}/teams/${team.id}/triage-rules`, {
      name: 'x',
      conditions: {},
      actions: { stateId: ids.triage },
    });
    expect(badState.statusCode).toBe(400);
    const res = await owner.post(`${ws}/teams/${team.id}/triage-rules`, {
      name: 'Crashes are urgent bugs',
      conditions: { text: 'crash' },
      actions: { priority: 1, labelIds: [ids.bug] },
    });
    expect(res.statusCode).toBe(200);
    ids.crash = (res.data as TriageRule).id;
    await owner.post(`${ws}/teams/${team.id}/triage-rules`, {
      name: 'API reports go to the on-call rotation',
      conditions: { sources: ['api', 'web'] },
      actions: { rotation: [ids.ada, ids.alan] },
    });
    expect(
      (await member.patch(`${ws}/triage-rules/${ids.crash}`, { enabled: false })).statusCode,
    ).toBe(403);
    expect((await member.del(`${ws}/triage-rules/${ids.crash}`)).statusCode).toBe(403);
    const listed = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!.triageRules;
    expect(listed.map((r) => r.name)).toEqual([
      'Crashes are urgent bugs',
      'API reports go to the on-call rotation',
    ]);
    expect(listed[0]!.enabled).toBe(true);
  });

  it('sort new triage issues, as the Ordo bot', async () => {
    const crash = await file('App crashes on login');
    expect(crash).toMatchObject({ priority: 1, labelIds: [ids.bug], assigneeId: ids.ada });
    const quiet = await file('Typo in footer');
    expect(quiet).toMatchObject({ priority: 0, labelIds: [], assigneeId: ids.alan });
    const third = await file('Another one');
    expect(third.assigneeId).toBe(ids.ada);
    const history = (await owner.get(`${ws}/issues/${crash.id}/history`)).data as HistoryEntry[];
    const botId = await automationBot(app.db, boot.workspace.id);
    expect(history.at(-1)!.actorId).toBe(botId);
    const [bot] = await app.db.select().from(users).where(eq(users.id, botId));
    expect(bot).toMatchObject({ kind: 'bot', name: 'Ordo', username: `${ids.squatted}2` });
    expect((await member.get('/api/auth/me')).data.username).toBe(ids.squatted);
  });

  it('leave issues outside triage alone, and skip disabled rules', async () => {
    const direct = (
      await member.post(`${ws}/issues`, {
        teamId: team.id,
        title: 'Crash again',
        stateId: ids.todo,
      })
    ).data as Issue;
    expect(direct).toMatchObject({ priority: 0, assigneeId: null });
    await owner.patch(`${ws}/triage-rules/${ids.crash}`, { enabled: false });
    const crash = await file('Crash while disabled');
    expect(crash.priority).toBe(0);
  });

  it('can accept issues straight into a status', async () => {
    await owner.patch(`${ws}/triage-rules/${ids.crash}`, {
      enabled: true,
      actions: { stateId: ids.todo },
    });
    const crash = await file('Crash: accepted');
    expect(crash.stateId).toBe(ids.todo);
    expect((await owner.del(`${ws}/triage-rules/${ids.crash}`)).statusCode).toBe(200);
  });
});
