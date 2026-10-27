import type { Bootstrap, Initiative, Issue, Project } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let guest: Client;
const ws = '/api/w/init';
const ids: Record<string, string> = {};

const initiatives = async (c: Client) =>
  ((await c.get(`${ws}/bootstrap`)).data as Bootstrap).initiatives;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Init',
    slug: 'init',
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
  ids.ops = (await owner.post(`${ws}/teams`, { name: 'Ops', key: 'OPS' })).data.id;
  const guestId = (await guest.get('/api/auth/me')).data.id;
  await owner.post(`${ws}/teams/${ids.ops}/members`, { userId: guestId });
  ids.web = (await owner.post(`${ws}/projects`, { name: 'Web', teamIds: [ids.pub] })).data.id;
  ids.secret = (await owner.post(`${ws}/projects`, { name: 'Secret', teamIds: [ids.prv] })).data.id;
  ids.infra = (await owner.post(`${ws}/projects`, { name: 'Infra', teamIds: [ids.ops] })).data.id;
});

afterAll(() => app.close());

describe('initiatives', () => {
  it('group projects and sum their progress', async () => {
    const res = await member.post(`${ws}/initiatives`, {
      name: 'Launch 2027',
      ownerId: ids.member,
      targetDate: '2027-03-01',
      status: 'active',
    });
    expect(res.statusCode).toBe(200);
    ids.launch = (res.data as Initiative).id;
    for (const p of [ids.web, ids.secret])
      expect(
        (await owner.patch(`${ws}/projects/${p}`, { initiativeId: ids.launch })).statusCode,
      ).toBe(200);
    const done = ((await owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams
      .find((t) => t.id === ids.pub)!
      .states.find((s) => s.type === 'completed')!.id;
    await owner.post(`${ws}/issues`, { teamId: ids.pub, title: 'A', projectId: ids.web });
    await owner.post(`${ws}/issues`, {
      teamId: ids.pub,
      title: 'B',
      projectId: ids.web,
      stateId: done,
    });
    await owner.post(`${ws}/issues`, { teamId: ids.prv, title: 'C', projectId: ids.secret });

    const [mine] = await initiatives(owner);
    expect(mine).toMatchObject({ name: 'Launch 2027', status: 'active', ownerId: ids.member });
    expect(mine!.projectIds.sort()).toEqual([ids.web, ids.secret].sort());
    expect(mine!.progress).toMatchObject({ total: 3, completed: 1 });
    // A member outside the private team sees only what they can see.
    const [theirs] = await initiatives(member);
    expect(theirs!.projectIds).toEqual([ids.web]);
    expect(theirs!.progress).toMatchObject({ total: 2, completed: 1 });
  });

  it('show guests only initiatives with their projects', async () => {
    expect(await initiatives(guest)).toEqual([]);
    const ops = (await owner.post(`${ws}/initiatives`, { name: 'Reliability' })).data as Initiative;
    await owner.patch(`${ws}/projects/${ids.infra}`, { initiativeId: ops.id });
    expect((await initiatives(guest)).map((i) => i.name)).toEqual(['Reliability']);
    expect((await guest.post(`${ws}/initiatives`, { name: 'Nope' })).statusCode).toBe(403);
    expect((await guest.patch(`${ws}/initiatives/${ops.id}`, { name: 'Mine' })).statusCode).toBe(
      403,
    );
  });

  it('check what projects are put in', async () => {
    const bad = await owner.patch(`${ws}/projects/${ids.web}`, {
      initiativeId: '00000000-0000-4000-8000-000000000000',
    });
    expect(bad.statusCode).toBe(400);
    const created = await owner.post(`${ws}/projects`, {
      name: 'Docs',
      teamIds: [ids.pub],
      initiativeId: ids.launch,
    });
    expect((created.data as Project).initiativeId).toBe(ids.launch);
  });

  it('update and delete, leaving their projects in place', async () => {
    const res = await member.patch(`${ws}/initiatives/${ids.launch}`, { status: 'completed' });
    expect((res.data as Initiative).status).toBe('completed');
    expect((await member.del(`${ws}/initiatives/${ids.launch}`)).statusCode).toBe(200);
    const web = (await owner.get(`${ws}/projects/${ids.web}`)).data as Project;
    expect(web.initiativeId).toBeNull();
    const issues = (await owner.post(`${ws}/issues/query`, { filter: { projectIds: [ids.web] } }))
      .data as Issue[];
    expect(issues).toHaveLength(2);
  });
});
