import type { Bootstrap, HistoryEntry, Issue, Project } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let guest: Client;
let member: Client;
const ws = '/api/w/mile';
const ids: Record<string, string> = {};
let project: Project;

const issue = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as Issue;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Mile',
    slug: 'mile',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token;
  guest = (await signup(app, 'Gus Guest', { inviteToken: await invite('guest') })).client;
  member = (await signup(app, 'Mona Member', { inviteToken: await invite('member') })).client;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  ids.pub = boot.teams[0]!.id;
  const guestId = (await guest.get('/api/auth/me')).data.id;
  await owner.post(`${ws}/teams/${ids.pub}/members`, { userId: guestId });
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })
  ).data.id;
  project = (await owner.post(`${ws}/projects`, { name: 'Launch', teamIds: [ids.pub] })).data;
  ids.other = (await owner.post(`${ws}/projects`, { name: 'Other', teamIds: [ids.pub] })).data.id;
  ids.secret = (await owner.post(`${ws}/projects`, { name: 'Secret', teamIds: [ids.prv] })).data.id;
});

afterAll(() => app.close());

describe('project milestones', () => {
  it('are created in date order, undated last', async () => {
    for (const body of [
      { name: 'Polish' },
      { name: 'Beta', targetDate: '2026-12-01' },
      { name: 'Alpha', targetDate: '2026-11-01', description: 'Internal' },
    ]) {
      const res = await owner.post(`${ws}/projects/${project.id}/milestones`, body);
      expect(res.statusCode).toBe(200);
      project = res.data;
    }
    expect(project.milestones.map((m) => m.name)).toEqual(['Alpha', 'Beta', 'Polish']);
    ids.alpha = project.milestones[0]!.id;
    ids.beta = project.milestones[1]!.id;
  });

  it('put issues in their project and count their progress', async () => {
    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const done = boot.teams
      .find((t) => t.id === ids.pub)!
      .states.find((s) => s.type === 'completed')!.id;
    const a = (
      await owner.post(`${ws}/issues`, { teamId: ids.pub, title: 'A', milestoneId: ids.alpha })
    ).data as Issue;
    expect(a).toMatchObject({ projectId: project.id, milestoneId: ids.alpha });
    ids.a = a.id;
    await owner.post(`${ws}/issues`, {
      teamId: ids.pub,
      title: 'B',
      milestoneId: ids.alpha,
      stateId: done,
    });
    const p = (await owner.get(`${ws}/projects/${project.id}`)).data as Project;
    expect(p.milestones[0]!.progress).toMatchObject({ total: 2, completed: 1 });
    const filtered = (
      await owner.post(`${ws}/issues/query`, { filter: { milestoneIds: [ids.alpha] } })
    ).data as Issue[];
    expect(filtered.map((i) => i.title).sort()).toEqual(['A', 'B']);
  });

  it("keep an issue's project and milestone consistent", async () => {
    await owner.patch(`${ws}/issues/${ids.a}`, { milestoneId: ids.beta });
    expect(await issue(ids.a!)).toMatchObject({ projectId: project.id, milestoneId: ids.beta });
    const bad = await owner.patch(`${ws}/issues/${ids.a}`, {
      projectId: ids.other,
      milestoneId: ids.alpha,
    });
    expect(bad.statusCode).toBe(400);
    await owner.patch(`${ws}/issues/${ids.a}`, { projectId: ids.other });
    expect(await issue(ids.a!)).toMatchObject({ projectId: ids.other, milestoneId: null });
    const history = (await owner.get(`${ws}/issues/${ids.a}/history`)).data as HistoryEntry[];
    expect(history.flatMap((h) => h.changes.map((c) => c.field))).toContain('milestone');
  });

  it('can be renamed, rescheduled and deleted; their issues stay in the project', async () => {
    const res = await member.patch(`${ws}/milestones/${ids.alpha}`, {
      name: 'Alpha 1',
      targetDate: '2027-01-01',
    });
    expect(res.statusCode).toBe(200);
    expect((res.data as Project).milestones.map((m) => m.name)).toEqual([
      'Beta',
      'Alpha 1',
      'Polish',
    ]);
    const left = (await owner.post(`${ws}/issues/query`, { filter: { milestoneIds: [ids.alpha] } }))
      .data as Issue[];
    expect((await owner.del(`${ws}/milestones/${ids.alpha}`)).statusCode).toBe(200);
    const after = await issue(left[0]!.id);
    expect(after).toMatchObject({ projectId: project.id, milestoneId: null });
  });

  it('follow the project rules: no guests, no hidden projects', async () => {
    expect(
      (await guest.post(`${ws}/projects/${project.id}/milestones`, { name: 'x' })).statusCode,
    ).toBe(403);
    expect(
      (await member.post(`${ws}/projects/${ids.secret}/milestones`, { name: 'x' })).statusCode,
    ).toBe(404);
    const secret = (await owner.post(`${ws}/projects/${ids.secret}/milestones`, { name: 'Hidden' }))
      .data as Project;
    const hidden = secret.milestones[0]!.id;
    expect((await member.patch(`${ws}/milestones/${hidden}`, { name: 'Mine' })).statusCode).toBe(
      404,
    );
    expect((await member.del(`${ws}/milestones/${hidden}`)).statusCode).toBe(404);
    const after = (await owner.get(`${ws}/projects/${ids.secret}`)).data as Project;
    expect(after.milestones.map((m) => m.name)).toEqual(['Hidden']);
    expect((await guest.patch(`${ws}/milestones/${ids.beta}`, { name: 'Mine' })).statusCode).toBe(
      403,
    );
    expect((await guest.del(`${ws}/milestones/${ids.beta}`)).statusCode).toBe(403);
  });

  it('can be planned by agents, which are guests of their teams', async () => {
    const agentId = (await owner.post(`${ws}/agents`, { name: 'Planner', teamIds: [ids.pub] })).data
      .id;
    const key = (await owner.post(`${ws}/agents/${agentId}/keys`, { name: 'k' })).data.token;
    const as = (method: 'POST' | 'PATCH', url: string, body: object) =>
      app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${key}` } });
    const made = await as('POST', `${ws}/projects/${project.id}/milestones`, { name: 'Agent' });
    expect(made.statusCode, made.body).toBe(200);
    const id = (made.json() as Project).milestones.find((m) => m.name === 'Agent')!.id;
    expect((await as('PATCH', `${ws}/milestones/${id}`, { name: 'Agent 2' })).statusCode).toBe(200);
    // Only milestones: the project itself stays out of an agent's hands, like a guest's.
    expect((await as('PATCH', `${ws}/projects/${project.id}`, { name: 'Mine' })).statusCode).toBe(
      403,
    );
    expect(
      (await as('POST', `${ws}/projects/${ids.secret}/milestones`, { name: 'x' })).statusCode,
    ).toBe(404);
  });
});
