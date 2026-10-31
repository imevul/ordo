import type { AgentActivityReport, Bootstrap, Dashboard } from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let lead: Client;
let guest: Client;
const slug = `dash-${Date.now()}`;
const ws = `/api/w/${slug}`;
const ids: Record<string, string> = {};

const names = async (who: Client) =>
  ((await who.get(`${ws}/bootstrap`)).data as Bootstrap).dashboards.map((d) => d.name).sort();

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Dagny Dashowner')).client;
  await owner.post('/api/workspaces', { name: 'Dash', slug, teamName: 'Eng', teamKey: 'DSH' });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token as string;
  member = (await signup(app, 'Mats Dashmember', { inviteToken: await invite('member') })).client;
  lead = (await signup(app, 'Lea Dashlead', { inviteToken: await invite('member') })).client;
  guest = (await signup(app, 'Gus Dashguest', { inviteToken: await invite('guest') })).client;
  for (const [k, c] of [
    ['member', member],
    ['lead', lead],
    ['guest', guest],
  ] as const)
    ids[k] = (await c.get('/api/auth/me')).data.id;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  ids.eng = boot.teams[0]!.id;
  ids.secret = (
    await owner.post(`${ws}/teams`, { name: 'Secret', key: 'SEC', private: true })
  ).data.id;
  await owner.post(`${ws}/teams/${ids.secret}/members`, { userId: ids.lead, role: 'admin' });
  await owner.post(`${ws}/teams/${ids.eng}/members`, { userId: ids.guest });
});
afterAll(() => app.close());

describe('dashboards', () => {
  it('creates a dashboard with widgets, filling in their defaults', async () => {
    const res = await member.post(`${ws}/dashboards`, {
      name: 'Team Eng',
      teamId: ids.eng,
      widgets: [
        { id: 'a', type: 'count', title: 'Urgent', filters: { priorities: [1] } },
        { id: 'b', type: 'chart', chart: 'burnUp', teamId: ids.eng, currentCycle: true, w: 4 },
        { id: 'c', type: 'agents' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const d = res.data as Dashboard;
    ids.team = d.id;
    expect(d).toMatchObject({
      name: 'Team Eng',
      teamId: ids.eng,
      shared: true,
      ownerId: ids.member,
    });
    expect(d.widgets).toEqual([
      {
        id: 'a',
        type: 'count',
        title: 'Urgent',
        filters: { priorities: [1] },
        w: 2,
        h: 1,
        measure: 'count',
      },
      expect.objectContaining({ id: 'b', chart: 'burnUp', w: 4, h: 1 }),
      { id: 'c', type: 'agents', days: 7, w: 2, h: 1 },
    ]);
    expect((await owner.get(`${ws}/dashboards/${d.id}`)).data.widgets).toHaveLength(3);
  });

  it('rejects widgets that cannot be drawn', async () => {
    const bad = async (widget: object) =>
      (await member.post(`${ws}/dashboards`, { name: 'Bad', widgets: [widget] })).statusCode;
    expect(await bad({ id: 'x', type: 'chart', chart: 'velocity' })).toBe(400);
    expect(await bad({ id: 'x', type: 'chart', chart: 'burndown', teamId: ids.eng })).toBe(400);
    expect(await bad({ id: 'x', type: 'chart', chart: 'burnUp', currentCycle: true })).toBe(400);
    expect(await bad({ id: 'x', type: 'count', filters: {}, w: 5 })).toBe(400);
    expect(await bad({ id: 'x', type: 'clock' })).toBe(400);
    const twice = await member.post(`${ws}/dashboards`, {
      name: 'Twice',
      widgets: [
        { id: 'x', type: 'agents' },
        { id: 'x', type: 'agents' },
      ],
    });
    expect(twice.statusCode).toBe(400);
  });

  it('keeps private dashboards to their owner and team ones to the team', async () => {
    await member.post(`${ws}/dashboards`, { name: 'Mine', shared: false });
    const secret = await lead.post(`${ws}/dashboards`, { name: 'Secret page', teamId: ids.secret });
    ids.secretDash = secret.data.id;
    // Members can't put a dashboard on a team they can't see.
    expect(
      (await member.post(`${ws}/dashboards`, { name: 'Sneak', teamId: ids.secret })).statusCode,
    ).toBe(404);

    expect(await names(member)).toEqual(['Mine', 'Team Eng']);
    expect(await names(lead)).toEqual(['Secret page', 'Team Eng']);
    expect(await names(owner)).toEqual(['Secret page', 'Team Eng']);
    expect(await names(guest)).toEqual(['Team Eng']);
    expect((await member.get(`${ws}/dashboards`)).data).toHaveLength(2);
    expect((await member.get(`${ws}/dashboards/${ids.secretDash}`)).statusCode).toBe(404);
    expect(
      (await member.patch(`${ws}/dashboards/${ids.secretDash}`, { name: 'x' })).statusCode,
    ).toBe(404);
    expect((await member.del(`${ws}/dashboards/${ids.secretDash}`)).statusCode).toBe(404);
  });

  it('keeps guests from making dashboards', async () => {
    const res = await guest.post(`${ws}/dashboards`, { name: 'Guest page' });
    expect(res.statusCode).toBe(403);
  });

  it('lets the owner, admins and the team’s admins change a dashboard', async () => {
    const theirs = (await lead.post(`${ws}/dashboards`, { name: 'Lead page' })).data.id;
    expect(
      (await member.patch(`${ws}/dashboards/${theirs}`, { name: 'Mine now' })).statusCode,
    ).toBe(403);
    expect((await member.del(`${ws}/dashboards/${theirs}`)).statusCode).toBe(403);

    // Lea administers the secret team, and so its shared dashboards; not Eng's.
    await owner.post(`${ws}/teams/${ids.eng}/members`, { userId: ids.lead, role: 'admin' });
    const layout = [{ id: 'z', type: 'agents', days: 30, w: 4, h: 2 }];
    const edited = await lead.patch(`${ws}/dashboards/${ids.team}`, { widgets: layout });
    expect(edited.statusCode).toBe(200);
    expect(edited.data.widgets).toEqual([{ id: 'z', type: 'agents', days: 30, w: 4, h: 2 }]);
    // Team admins can't hide someone's dashboard from them.
    expect((await lead.patch(`${ws}/dashboards/${ids.team}`, { shared: false })).statusCode).toBe(
      403,
    );
    expect((await owner.patch(`${ws}/dashboards/${theirs}`, { name: 'Renamed' })).data.name).toBe(
      'Renamed',
    );
    expect((await member.patch(`${ws}/dashboards/${ids.team}`, { shared: false })).statusCode).toBe(
      200,
    );
    expect(await names(lead)).not.toContain('Team Eng');
    expect((await owner.del(`${ws}/dashboards/${theirs}`)).statusCode).toBe(200);
  });

  it('can be a favorite while it is visible', async () => {
    await owner.post(`${ws}/favorites`, { kind: 'dashboard', targetId: ids.secretDash });
    await member.post(`${ws}/favorites`, { kind: 'dashboard', targetId: ids.secretDash });
    const favs = async (who: Client) =>
      ((await who.get(`${ws}/bootstrap`)).data as Bootstrap).favorites.filter(
        (f) => f.kind === 'dashboard',
      );
    expect(await favs(owner)).toHaveLength(1);
    expect(await favs(member)).toHaveLength(0);
  });
});

describe('agent activity', () => {
  it('counts recent runs and their cost on issues the caller can read', async () => {
    const agent = (
      await owner.post(`${ws}/agents`, { name: 'Dash Bot', teamIds: [ids.eng, ids.secret] })
    ).data.id as string;
    const run = async (teamId: string, status: string, costUsd: number, ageDays = 0) => {
      const issue = (
        await owner.post(`${ws}/issues`, { teamId, title: `Run ${status}`, assigneeId: agent })
      ).data;
      const createdAt = new Date(Date.now() - ageDays * 86_400_000).toISOString();
      await app.db
        .update(agentRuns)
        .set({ status: status as 'queued', costUsd, durationMs: 60_000, createdAt })
        .where(eq(agentRuns.issueId, issue.id));
    };
    await run(ids.eng, 'succeeded', 1.5);
    await run(ids.eng, 'failed', 0.25);
    await run(ids.eng, 'queued', 0);
    await run(ids.eng, 'succeeded', 9, 10);
    await run(ids.secret, 'succeeded', 4);

    const of = async (who: Client, q = '') =>
      (await who.get(`${ws}/agent-activity${q}`)).data as AgentActivityReport;
    expect((await of(member)).agents).toEqual([
      {
        agentId: agent,
        runs: 3,
        succeeded: 1,
        failed: 1,
        open: 1,
        costUsd: 1.75,
        durationMs: 180_000,
      },
    ]);
    expect((await of(owner)).agents[0]).toMatchObject({ runs: 4, costUsd: 5.75 });
    expect((await of(owner, '?days=30')).agents[0]).toMatchObject({ runs: 5, costUsd: 14.75 });
    expect((await of(owner, `?teamId=${ids.secret}`)).agents[0]).toMatchObject({ runs: 1 });
    expect((await member.get(`${ws}/agent-activity?teamId=${ids.secret}`)).statusCode).toBe(404);
    expect((await member.get(`${ws}/agent-activity?days=500`)).statusCode).toBe(400);
  });
});
