import type { AgentRun, Bootstrap, Issue } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let ownerId: string;
let bea: string;
let agentId: string;
let eng: string;
let prv: string;
const slug = `da-${Date.now()}`;
const ws = `/api/w/${slug}`;

const create = async (body: Record<string, unknown>) => {
  const res = await owner.post(`${ws}/issues`, { teamId: eng, title: 'An issue', ...body });
  expect(res.statusCode).toBe(200);
  return res.data as Issue;
};

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Dora Default')).client;
  ownerId = (await owner.get('/api/auth/me')).data.id;
  await owner.post('/api/workspaces', { name: 'DA', slug, teamName: 'Eng', teamKey: 'ENG' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  const b = (await signup(app, 'Bea Member', { inviteToken: invite })).client;
  bea = (await b.get('/api/auth/me')).data.id;
  const boot: Bootstrap = (await owner.get(`${ws}/bootstrap`)).data;
  eng = boot.teams[0]!.id;
  prv = (await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })).data.id;
  agentId = (await owner.post(`${ws}/agents`, { name: 'Default Bot', teamIds: [eng] })).data.id;
});
afterAll(() => app.close());

describe('default assignee', () => {
  it('is nobody until set', async () => {
    expect((await create({})).assigneeId).toBeNull();
  });

  it('is set in the workspace settings, to members only', async () => {
    const outsider = (await signup(app, 'Otto Outside')).client;
    const outsiderId = (await outsider.get('/api/auth/me')).data.id;
    const bad = await owner.patch(`${ws}/`, { settings: { defaultAssigneeId: outsiderId } });
    expect(bad.statusCode).toBe(400);
    const res = await owner.patch(`${ws}/`, { settings: { defaultAssigneeId: agentId } });
    expect(res.data.settings.defaultAssigneeId).toBe(agentId);
  });

  it('assigns new issues that leave the assignee out, and queues the agent', async () => {
    const issue = await create({});
    expect(issue.assigneeId).toBe(agentId);
    const runs = (await owner.get(`${ws}/issues/${issue.id}/agent-runs`)).data as AgentRun[];
    expect(runs.map((r) => r.status)).toEqual(['queued']);
    // An explicit choice wins, "nobody" included.
    expect((await create({ assigneeId: null })).assigneeId).toBeNull();
    expect((await create({ assigneeId: bea })).assigneeId).toBe(bea);
  });

  it("skips someone who can't work in the team", async () => {
    expect((await create({ teamId: prv })).assigneeId).toBeNull();
  });

  it('leaves triage to whoever triages', async () => {
    await owner.patch(`${ws}/teams/${eng}`, { triageEnabled: true });
    const boot: Bootstrap = (await owner.get(`${ws}/bootstrap`)).data;
    const triage = boot.teams.find((t) => t.id === eng)!.states.find((s) => s.type === 'triage')!;
    expect((await create({ stateId: triage.id })).assigneeId).toBeNull();
    await owner.patch(`${ws}/teams/${eng}`, { triageEnabled: false });
  });

  it('is overridden per project: someone, nobody, or back to the workspace', async () => {
    const project = (await owner.post(`${ws}/projects`, { name: 'P', teamIds: [eng] })).data;
    expect(project.defaultAssignee).toBe('workspace');
    expect((await create({ projectId: project.id })).assigneeId).toBe(agentId);

    let res = await owner.patch(`${ws}/projects/${project.id}`, { defaultAssignee: ownerId });
    expect(res.data.defaultAssignee).toBe(ownerId);
    expect((await create({ projectId: project.id })).assigneeId).toBe(ownerId);

    res = await owner.patch(`${ws}/projects/${project.id}`, { defaultAssignee: 'none' });
    expect(res.data.defaultAssignee).toBe('none');
    expect((await create({ projectId: project.id })).assigneeId).toBeNull();
    // Other changes leave the choice alone.
    res = await owner.patch(`${ws}/projects/${project.id}`, { name: 'Renamed' });
    expect(res.data.defaultAssignee).toBe('none');

    res = await owner.patch(`${ws}/projects/${project.id}`, { defaultAssignee: 'workspace' });
    expect(res.data.defaultAssignee).toBe('workspace');
    expect((await create({ projectId: project.id })).assigneeId).toBe(agentId);

    const outsider = (await signup(app, 'Ola Outside')).client;
    const outsiderId = (await outsider.get('/api/auth/me')).data.id;
    expect(
      (await owner.patch(`${ws}/projects/${project.id}`, { defaultAssignee: outsiderId }))
        .statusCode,
    ).toBe(400);
  });

  it('can be cleared', async () => {
    await owner.patch(`${ws}/`, { settings: { defaultAssigneeId: null } });
    expect((await create({})).assigneeId).toBeNull();
  });
});
