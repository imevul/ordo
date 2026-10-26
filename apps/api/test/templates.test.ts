import type { Bootstrap, IssueTemplate } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let insider: Client;
let guest: Client;
const ws = '/api/w/tpl';
const ids: Record<string, string> = {};
let boot: Bootstrap;

const templates = async (c: Client) =>
  ((await c.get(`${ws}/bootstrap`)).data as Bootstrap).templates;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Olga Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Tpl',
    slug: 'tpl',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token;
  member = (await signup(app, 'Mona Member', { inviteToken: await invite('member') })).client;
  insider = (await signup(app, 'Ines Insider', { inviteToken: await invite('member') })).client;
  guest = (await signup(app, 'Gus Guest', { inviteToken: await invite('guest') })).client;
  ids.member = (await member.get('/api/auth/me')).data.id;
  ids.insider = (await insider.get('/api/auth/me')).data.id;
  const prv = (await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true }))
    .data;
  ids.prv = prv.id;
  await owner.post(`${ws}/teams/${prv.id}/members`, { userId: ids.insider });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  const pub = boot.teams.find((t) => t.key === 'PUB')!;
  ids.pub = pub.id;
  ids.guestId = (await guest.get('/api/auth/me')).data.id;
  await owner.post(`${ws}/teams/${pub.id}/members`, { userId: ids.guestId });
  ids.todo = pub.states.find((s) => s.type === 'unstarted')!.id;
  ids.prvState = prv.states?.[0]?.id ?? boot.teams.find((t) => t.id === prv.id)?.states[0]?.id;
  ids.bug = (await owner.post(`${ws}/labels`, { name: 'Bug', color: '#ef4444' })).data.id;
  ids.pubLabel = (
    await owner.post(`${ws}/labels`, { name: 'Frontend', color: '#60a5fa', teamId: pub.id })
  ).data.id;
});

afterAll(() => app.close());

describe('issue templates', () => {
  it('lets members make workspace templates that everyone sees', async () => {
    const res = await member.post(`${ws}/templates`, {
      name: 'Bug report',
      title: 'Bug: ',
      description: '## Steps\n\n1. \n\n## Expected',
      priority: 2,
      labelIds: [ids.bug, ids.bug],
    });
    expect(res.statusCode).toBe(200);
    const t = res.data as IssueTemplate;
    expect(t).toMatchObject({ teamId: null, name: 'Bug report', priority: 2, labelIds: [ids.bug] });
    ids.bugTemplate = t.id;
    for (const c of [owner, insider, guest])
      expect((await templates(c)).map((x) => x.id)).toContain(t.id);
    expect((await member.get(`${ws}/templates`)).data.map((x: IssueTemplate) => x.id)).toEqual([
      t.id,
    ]);
  });

  it('checks that defaults fit where the template is used', async () => {
    const bad = [
      { name: 'x', stateId: ids.todo }, // a status needs a team
      { name: 'x', labelIds: [ids.pubLabel] }, // team label on a workspace template
      { name: 'x', teamId: ids.pub, stateId: ids.prvState }, // another team's status
      {
        name: 'x',
        teamId: ids.pub,
        assigneeId: ids.insider,
        labelIds: ['00000000-0000-4000-8000-000000000000'],
      },
      { name: '' },
    ];
    for (const body of bad)
      expect((await member.post(`${ws}/templates`, body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    const ok = await member.post(`${ws}/templates`, {
      name: 'Frontend task',
      teamId: ids.pub,
      stateId: ids.todo,
      assigneeId: ids.member,
      labelIds: [ids.bug, ids.pubLabel],
      estimate: 3,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.data).toMatchObject({ teamId: ids.pub, stateId: ids.todo, estimate: 3 });
  });

  it("keeps private teams' templates private", async () => {
    const res = await insider.post(`${ws}/templates`, { name: 'Secret', teamId: ids.prv });
    expect(res.statusCode).toBe(200);
    expect((await templates(insider)).map((t) => t.name)).toContain('Secret');
    expect((await templates(owner)).map((t) => t.name)).toContain('Secret');
    for (const c of [member, guest]) {
      expect((await templates(c)).map((t) => t.name)).not.toContain('Secret');
      expect((await c.patch(`${ws}/templates/${res.data.id}`, { name: 'Mine' })).statusCode).toBe(
        404,
      );
    }
    expect((await member.post(`${ws}/templates`, { name: 'x', teamId: ids.prv })).statusCode).toBe(
      400,
    );
  });

  it("doesn't let guests manage templates", async () => {
    expect((await guest.post(`${ws}/templates`, { name: 'Nope' })).statusCode).toBe(403);
    expect((await guest.del(`${ws}/templates/${ids.bugTemplate}`)).statusCode).toBe(403);
  });

  it('updates and deletes', async () => {
    const res = await insider.patch(`${ws}/templates/${ids.bugTemplate}`, {
      name: 'Bug',
      priority: null,
      labelIds: [],
    });
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ name: 'Bug', priority: null, labelIds: [], title: 'Bug: ' });
    expect((await owner.del(`${ws}/templates/${ids.bugTemplate}`)).statusCode).toBe(200);
    expect((await templates(owner)).map((t) => t.id)).not.toContain(ids.bugTemplate);
  });
});
