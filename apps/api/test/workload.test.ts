import type { Bootstrap, CycleWorkload, Team } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
const ws = '/api/w/load';
const c: Record<'owner' | 'member' | 'guest' | 'outsider', Client> = {} as never;
const ids: Record<string, string> = {};
let team: Team;
let cycleId: string;

const state = (type: string) => team.states.find((s) => s.type === type)!.id;
const workload = async (who: Client = c.owner) =>
  (await who.get(`${ws}/cycles/${cycleId}/workload`)).data as CycleWorkload;
const entryOf = (w: CycleWorkload, userId: string | null) =>
  w.entries.find((e) => e.userId === userId);
const issue = (body: object) =>
  c.owner.post(`${ws}/issues`, { teamId: team.id, cycleId, ...body }).then((r) => r.data.id);

beforeAll(async () => {
  app = await testApp();
  c.owner = (await signup(app, 'Wanda Workload')).client;
  await c.owner.post('/api/workspaces', {
    name: 'Load',
    slug: 'load',
    teamName: 'Eng',
    teamKey: 'LOAD',
  });
  const invite = async (role: string) =>
    (await c.owner.post(`${ws}/invites`, { role })).data[0].token as string;
  c.member = (await signup(app, 'Carl Capacity', { inviteToken: await invite('member') })).client;
  c.guest = (await signup(app, 'Greta Guestload', { inviteToken: await invite('guest') })).client;
  // In the workspace, not on the team.
  c.outsider = (
    await signup(app, 'Oskar Overload', { inviteToken: await invite('member') })
  ).client;
  for (const k of Object.keys(c) as (keyof typeof c)[])
    ids[k] = (await c[k].get('/api/auth/me')).data.id;
  team = ((await c.owner.get(`${ws}/bootstrap`)).data as Bootstrap).teams[0]!;
  for (const u of [ids.member, ids.guest])
    await c.owner.post(`${ws}/teams/${team.id}/members`, { userId: u });
  cycleId = (
    await c.owner.post(`${ws}/teams/${team.id}/cycles`, {
      startsAt: '2026-11-02',
      endsAt: '2026-11-16',
    })
  ).data.id;
});

afterAll(() => app.close());

describe('cycle workload', () => {
  it('counts issues when nothing is estimated', async () => {
    await issue({ title: 'Unplanned one', assigneeId: ids.owner });
    await issue({ title: 'Nobody has this' });
    const w = await workload();
    expect(w.unit).toBe('issues');
    expect(entryOf(w, ids.owner)).toMatchObject({ load: 1, issueCount: 1, capacity: null });
    expect(entryOf(w, ids.member)).toMatchObject({ load: 0, issues: [] });
    expect(w.entries.at(-1)).toMatchObject({ userId: null, load: 1 });
  });

  it('sums estimates once any issue has one, skipping canceled issues', async () => {
    await issue({ title: 'Big', assigneeId: ids.member, estimate: 5 });
    await issue({
      title: 'Done',
      assigneeId: ids.member,
      estimate: 3,
      stateId: state('completed'),
    });
    await issue({
      title: 'Dropped',
      assigneeId: ids.member,
      estimate: 8,
      stateId: state('canceled'),
    });
    const w = await workload();
    expect(w.unit).toBe('points');
    expect(entryOf(w, ids.member)).toMatchObject({ load: 8, completed: 3, issueCount: 2 });
    expect(entryOf(w, ids.owner)).toMatchObject({ load: 0, unestimated: 1 });
    expect(entryOf(w, ids.member)!.issues.map((i) => i.identifier)).toEqual(['LOAD-3', 'LOAD-4']);
  });

  it('takes capacity from the cycle, then the member, then the team', async () => {
    expect(
      (await c.owner.patch(`${ws}/teams/${team.id}`, { defaultCapacity: 10 })).statusCode,
    ).toBe(200);
    let w = await workload();
    expect(entryOf(w, ids.member)).toMatchObject({ capacity: 10, capacitySource: 'team' });

    const own = await c.owner.patch(`${ws}/teams/${team.id}/members/${ids.member}`, {
      capacity: 6,
    });
    expect(own.statusCode).toBe(200);
    const boot = (await c.owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const t = boot.teams.find((x) => x.id === team.id)!;
    expect(t.defaultCapacity).toBe(10);
    expect(t.members.find((m) => m.userId === ids.member)).toMatchObject({
      role: 'member',
      capacity: 6,
    });
    w = await workload();
    expect(entryOf(w, ids.member)).toMatchObject({ capacity: 6, capacitySource: 'member' });

    // A vacation: less this cycle. Anyone who plans the cycle may set it.
    const put = await c.member.put(`${ws}/cycles/${cycleId}/capacity/${ids.member}`, {
      capacity: 2,
    });
    expect(put.statusCode).toBe(200);
    w = await workload();
    expect(entryOf(w, ids.member)).toMatchObject({ load: 8, capacity: 2, capacitySource: 'cycle' });

    await c.member.put(`${ws}/cycles/${cycleId}/capacity/${ids.member}`, { capacity: null });
    w = await workload();
    expect(entryOf(w, ids.member)).toMatchObject({ capacity: 6, capacitySource: 'member' });
  });

  it('lists assignees from outside the team after its members', async () => {
    await c.owner.del(`${ws}/teams/${team.id}/members/${ids.outsider}`);
    await issue({ title: 'Borrowed hands', assigneeId: ids.outsider, estimate: 1 });
    const w = await workload();
    const i = w.entries.findIndex((e) => e.userId === ids.outsider);
    expect(w.entries[i]).toMatchObject({ outsideTeam: true, load: 1 });
    expect(i).toBe(w.entries.length - 2);
  });

  it('rejects bad capacities and people outside the team', async () => {
    const url = `${ws}/cycles/${cycleId}/capacity`;
    expect((await c.owner.put(`${url}/${ids.member}`, { capacity: -1 })).statusCode).toBe(400);
    expect((await c.owner.put(`${url}/${ids.member}`, { capacity: 1.5 })).statusCode).toBe(400);
    const stranger = (await signup(app, 'Stella Stranger')).client;
    const strangerId = (await stranger.get('/api/auth/me')).data.id;
    expect((await c.owner.put(`${url}/${strangerId}`, { capacity: 3 })).statusCode).toBe(400);
    expect(
      (await c.owner.patch(`${ws}/teams/${team.id}/members/${ids.member}`, {})).statusCode,
    ).toBe(400);
  });

  it('lets guests look but not plan, and hides the cycle from outsiders', async () => {
    expect((await c.guest.get(`${ws}/cycles/${cycleId}/workload`)).statusCode).toBe(200);
    expect(
      (await c.guest.put(`${ws}/cycles/${cycleId}/capacity/${ids.guest}`, { capacity: 1 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await c.member.patch(`${ws}/teams/${team.id}/members/${ids.member}`, { capacity: 99 }))
        .statusCode,
    ).toBe(403);
    const stranger = (await signup(app, 'Petra Peeker')).client;
    expect((await stranger.get(`${ws}/cycles/${cycleId}/workload`)).statusCode).toBe(404);
  });
});
