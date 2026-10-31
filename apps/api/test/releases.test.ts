import type { Bootstrap, HistoryEntry, Issue, Release } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let guest: Client;
let member: Client;
const ws = '/api/w/rel';
const ids: Record<string, string> = {};

const create = async (title: string, extra: Record<string, unknown> = {}) =>
  (await owner.post(`${ws}/issues`, { teamId: ids.pub, title, ...extra })).data as Issue;

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Rita Releaser')).client;
  await owner.post('/api/workspaces', {
    name: 'Rel',
    slug: 'rel',
    teamName: 'Pub',
    teamKey: 'PUB',
  });
  const invite = async (role: string) =>
    (await owner.post(`${ws}/invites`, { role })).data[0].token;
  guest = (await signup(app, 'Gil Guestly', { inviteToken: await invite('guest') })).client;
  member = (await signup(app, 'Mel Memberly', { inviteToken: await invite('member') })).client;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  const pub = boot.teams[0]!;
  ids.pub = pub.id;
  ids.done = pub.states.find((s) => s.type === 'completed')!.id;
  ids.canceled = pub.states.find((s) => s.type === 'canceled')!.id;
  ids.todo = pub.states.find((s) => s.type === 'unstarted')!.id;
  await owner.post(`${ws}/teams/${ids.pub}/members`, {
    userId: (await guest.get('/api/auth/me')).data.id,
  });
  ids.prv = (
    await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })
  ).data.id;
  ids.feature = (await owner.post(`${ws}/labels`, { name: 'Feature', color: '#22c55e' })).data.id;
  ids.bug = (await owner.post(`${ws}/labels`, { name: 'Bug', color: '#ef4444' })).data.id;
});

afterAll(() => app.close());

describe('releases', () => {
  it('are created workspace-wide or for a team, and listed in the bootstrap', async () => {
    const res = await owner.post(`${ws}/releases`, { name: 'v0.1', targetDate: '2026-11-01' });
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ name: 'v0.1', teamId: null, releasedAt: null, notes: '' });
    ids.v01 = res.data.id;
    const team = await owner.post(`${ws}/releases`, { name: 'PRV 1', teamId: ids.prv });
    expect(team.data.teamId).toBe(ids.prv);
    ids.prvRelease = team.data.id;
    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    expect(boot.releases.map((r) => r.name).sort()).toEqual(['PRV 1', 'v0.1']);
    // Lists leave the notes out.
    expect(boot.releases[0]).not.toHaveProperty('notes');
  });

  it('are managed by members but not guests, and hidden outside their team', async () => {
    expect((await guest.post(`${ws}/releases`, { name: 'Nope' })).statusCode).toBe(403);
    expect((await guest.patch(`${ws}/releases/${ids.v01}`, { name: 'x' })).statusCode).toBe(403);
    const mine = await member.post(`${ws}/releases`, { name: 'Scratch' });
    expect(mine.statusCode).toBe(200);
    expect((await member.del(`${ws}/releases/${mine.data.id}`)).statusCode).toBe(200);
    expect((await member.get(`${ws}/releases/${ids.prvRelease}`)).statusCode).toBe(404);
    expect(
      (await member.post(`${ws}/releases`, { name: 'Sneaky', teamId: ids.prv })).statusCode,
    ).toBe(404);
    const memberList = (await member.get(`${ws}/releases`)).data as Release[];
    expect(memberList.map((r) => r.name)).toEqual(['v0.1']);
    // A guest sees no workspace-wide release until one holds an issue they can see.
    expect((await guest.get(`${ws}/releases`)).data).toEqual([]);
  });

  it('take issues of their team, which are counted and filterable', async () => {
    const a = await create('Dark mode', {
      stateId: ids.done,
      labelIds: [ids.feature],
      releaseId: ids.v01,
    });
    expect(a.releaseId).toBe(ids.v01);
    ids.a = a.id;
    const b = await create('Crash on save', { stateId: ids.done, labelIds: [ids.bug] });
    const patched = await owner.patch(`${ws}/issues/${b.id}`, { releaseId: ids.v01 });
    expect(patched.data.releaseId).toBe(ids.v01);
    ids.b = b.id;
    const c = await create('Abandoned', { stateId: ids.canceled, releaseId: ids.v01 });
    ids.c = c.id;
    // Another team's release can't take it.
    const wrong = await owner.post(`${ws}/issues`, {
      teamId: ids.pub,
      title: 'Wrong team',
      releaseId: ids.prvRelease,
    });
    expect(wrong.statusCode).toBe(400);

    const history = (await owner.get(`${ws}/issues/${b.id}/history`)).data as HistoryEntry[];
    expect(history.flatMap((h) => h.changes).some((ch) => ch.field === 'release')).toBe(true);

    const release = (await owner.get(`${ws}/releases/${ids.v01}`)).data as Release;
    expect(release.progress).toMatchObject({ total: 3, completed: 2, canceled: 1 });
    const filtered = (await owner.post(`${ws}/issues/query`, { filter: { releaseIds: [ids.v01] } }))
      .data as Issue[];
    expect(filtered).toHaveLength(3);
    const none = (await owner.post(`${ws}/issues/query`, { filter: { releaseIds: ['none'] } }))
      .data as Issue[];
    expect(none.some((i) => i.releaseId)).toBe(false);
    // Now a guest can see the release: it holds issues of their team.
    expect(((await guest.get(`${ws}/releases`)).data as Release[]).map((r) => r.name)).toEqual([
      'v0.1',
    ]);
  });

  it('drafts notes grouped by label, leaving canceled issues out', async () => {
    const res = await owner.post(`${ws}/releases/${ids.v01}/draft`);
    expect(res.statusCode).toBe(200);
    expect(res.data.notes).toBe(
      '## Bug\n\n- Crash on save (PUB-2)\n\n## Feature\n\n- Dark mode (PUB-1)',
    );
    // Drafting doesn't save.
    expect((await owner.get(`${ws}/releases/${ids.v01}`)).data.notes).toBe('');
  });

  it('freeze their issue list once released, with drafted notes', async () => {
    const res = await owner.post(`${ws}/releases/${ids.v01}/release`);
    expect(res.statusCode).toBe(200);
    expect(res.data.releasedAt).toBeTruthy();
    expect(res.data.notes).toContain('## Feature');
    expect((await owner.post(`${ws}/releases/${ids.v01}/release`)).statusCode).toBe(400);

    expect((await owner.patch(`${ws}/issues/${ids.a}`, { releaseId: null })).statusCode).toBe(400);
    const join = await owner.post(`${ws}/issues`, {
      teamId: ids.pub,
      title: 'Late',
      releaseId: ids.v01,
    });
    expect(join.statusCode).toBe(400);
    // Other edits still work.
    expect((await owner.patch(`${ws}/issues/${ids.a}`, { title: 'Dark mode!' })).statusCode).toBe(
      200,
    );
  });

  it('exports the notes as Markdown', async () => {
    const res = await owner.get(`${ws}/releases/${ids.v01}/notes.md`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('v0.1.md');
    expect(res.body).toMatch(/^# v0\.1 \(\d{4}-\d{2}-\d{2}\)\n\n## Bug\n/);
    expect((await member.get(`${ws}/releases/${ids.prvRelease}/notes.md`)).statusCode).toBe(404);
  });

  it('keep notes someone wrote when released', async () => {
    const r = (await owner.post(`${ws}/releases`, { name: 'v0.2', notes: 'Hand-written' })).data;
    ids.v02 = r.id;
    const out = await owner.post(`${ws}/releases/${r.id}/release`);
    expect(out.data.notes).toBe('Hand-written');
    const back = await owner.post(`${ws}/releases/${r.id}/reopen`);
    expect(back.data.releasedAt).toBeNull();
    expect((await owner.post(`${ws}/releases/${r.id}/reopen`)).statusCode).toBe(400);
  });

  it('suggest done issues completed since the last release, in no release', async () => {
    const fresh = await create('Fresh', { stateId: ids.done });
    const open = await create('Still open', { stateId: ids.todo });
    const list = (await owner.get(`${ws}/releases/${ids.v02}/suggestions`)).data as Issue[];
    const titles = list.map((i) => i.title);
    expect(titles).toContain('Fresh');
    expect(titles).not.toContain('Still open');
    expect(titles).not.toContain('Crash on save');
    expect(list.every((i) => i.id !== open.id)).toBe(true);
    ids.fresh = fresh.id;
  });

  it('reopened, take issues again; deleted, let go of them', async () => {
    await owner.post(`${ws}/releases/${ids.v01}/reopen`);
    const batch = await owner.post(`${ws}/issues/batch`, {
      ids: [ids.fresh],
      patch: { releaseId: ids.v01 },
    });
    expect(batch.statusCode).toBe(200);
    expect((await owner.get(`${ws}/issues/${ids.fresh}`)).data.releaseId).toBe(ids.v01);
    expect((await owner.del(`${ws}/releases/${ids.v01}`)).statusCode).toBe(200);
    expect((await owner.get(`${ws}/issues/${ids.fresh}`)).data.releaseId).toBeNull();
    expect((await owner.get(`${ws}/issues/${ids.a}`)).data.releaseId).toBeNull();
    expect((await owner.get(`${ws}/releases/${ids.v01}`)).statusCode).toBe(404);
  });

  it("drops a team release when the issue moves to another team, unless it's out", async () => {
    const pubRelease = (await owner.post(`${ws}/releases`, { name: 'PUB 1', teamId: ids.pub }))
      .data;
    const moving = await create('Mover', { releaseId: pubRelease.id });
    const moved = await owner.patch(`${ws}/issues/${moving.id}`, { teamId: ids.prv });
    expect(moved.statusCode).toBe(200);
    expect(moved.data.releaseId).toBeNull();
  });

  it("hide a workspace-wide release's suggestions from a guest it holds nothing of", async () => {
    const empty = (await owner.post(`${ws}/releases`, { name: 'Empty' })).data as Release;
    ids.empty = empty.id;
    expect((await guest.get(`${ws}/releases/${empty.id}`)).statusCode).toBe(404);
    expect((await guest.get(`${ws}/releases/${empty.id}/suggestions`)).statusCode).toBe(404);
    expect((await member.get(`${ws}/releases/${empty.id}/suggestions`)).statusCode).toBe(200);
  });

  it('add more issues at once than a batch edit takes', async () => {
    const created: Issue[] = [];
    for (let i = 0; i < 260; i += 20) {
      created.push(
        ...(await Promise.all(
          Array.from({ length: 20 }, (_, j) => create(`Bulk ${i + j}`, { stateId: ids.done })),
        )),
      );
    }
    const suggested = (await owner.get(`${ws}/releases/${ids.empty}/suggestions`)).data as Issue[];
    expect(suggested.length).toBeGreaterThan(250);
    // Newest completed first.
    const completed = suggested.map((i) => i.completedAt ?? '');
    expect(completed).toEqual([...completed].sort().reverse());

    const res = await owner.post(`${ws}/releases/${ids.empty}/issues`, {
      ids: suggested.map((i) => i.id),
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.ids).toHaveLength(suggested.length);
    const release = (await owner.get(`${ws}/releases/${ids.empty}`)).data as Release;
    expect(release.progress.total).toBe(suggested.length);
    expect((await owner.get(`${ws}/releases/${ids.empty}/suggestions`)).data).toEqual([]);
    ids.bulk0 = created[0]!.id;
    const history = (await owner.get(`${ws}/issues/${ids.bulk0}/history`)).data as HistoryEntry[];
    expect(history.some((h) => h.changes.some((c) => c.field === 'release'))).toBe(true);
  });

  it('only add issues to a release that is open, of its team, by a non-guest', async () => {
    const issue = await create('Late addition', { stateId: ids.done });
    const body = { ids: [issue.id] };
    expect((await guest.post(`${ws}/releases/${ids.empty}/issues`, body)).statusCode).toBe(403);
    // A PRV release can't take a PUB issue.
    expect((await owner.post(`${ws}/releases/${ids.prvRelease}/issues`, body)).statusCode).toBe(
      400,
    );
    await owner.post(`${ws}/releases/${ids.empty}/release`, { draft: false });
    expect((await owner.post(`${ws}/releases/${ids.empty}/issues`, body)).statusCode).toBe(400);
    // Nor can an issue leave a release that's out for another one.
    const next = (await owner.post(`${ws}/releases`, { name: 'Next' })).data as Release;
    const shipped = { ids: [ids.bulk0] };
    expect((await owner.post(`${ws}/releases/${next.id}/issues`, shipped)).statusCode).toBe(400);
    expect((await owner.get(`${ws}/issues/${ids.bulk0}`)).data.releaseId).toBe(ids.empty);
    expect((await owner.post(`${ws}/releases/${next.id}/issues`, body)).statusCode).toBe(200);
  });
});
