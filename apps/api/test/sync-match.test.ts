import type { Bootstrap, IssueFilter, StateType } from '@ordo/shared';
import { matchIssue } from '@ordo/sync/match';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeAccess } from '../src/services/access.ts';
import { queryIssues, workspaceIssuePage } from '../src/services/issues.ts';
import { type Client, signup, testApp } from './helpers.ts';

/**
 * Sync clients filter their own copy with `matchIssue`; the server filters with SQL. Random
 * filters over a random workspace must pick the same issues either way.
 */

let app: FastifyInstance;
let owner: Client;
let ownerId: string;
let boot: Bootstrap;
const slug = `match-${Date.now()}`;
const ws = `/api/w/${slug}`;

// A small seeded generator, so a failure can be replayed.
let seed = 20261027;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
const some = <T>(list: T[], max = 3) => [
  ...new Set(Array.from({ length: 1 + Math.floor(rand() * max) }, () => pick(list))),
];

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Match Owner')).client;
  ownerId = (await owner.get('/api/auth/me')).data.id;
  await owner.post('/api/workspaces', { name: 'Match', slug, teamName: 'One', teamKey: 'ONE' });
  await owner.post(`${ws}/teams`, { name: 'Two', key: 'TWO' });
  const other = (
    await signup(app, 'Match Member', {
      inviteToken: (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token,
    })
  ).data;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  for (const team of boot.teams) {
    await owner.post(`${ws}/teams/${team.id}/members`, { userId: other.user?.id ?? other.id });
    for (const name of ['Bug', 'Feature'])
      await owner.post(`${ws}/labels`, {
        name: `${name} ${team.key}`,
        color: '#ff1493',
        teamId: team.id,
      });
    await owner.post(`${ws}/teams/${team.id}/cycles`, {
      startsAt: '2026-01-01',
      endsAt: '2026-01-15',
    });
  }
  const project = (
    await owner.post(`${ws}/projects`, { name: 'P', teamIds: boot.teams.map((t) => t.id) })
  ).data;
  await owner.post(`${ws}/projects/${project.id}/milestones`, { name: 'M1' });
  boot = (await owner.get(`${ws}/bootstrap`)).data;

  const members = boot.members.map((m) => m.id);
  for (let i = 0; i < 60; i++) {
    const team = pick(boot.teams);
    const labels = boot.labels.filter((l) => !l.teamId || l.teamId === team.id).map((l) => l.id);
    const cycles = boot.cycles.filter((c) => c.teamId === team.id).map((c) => c.id);
    const milestones = boot.projects.flatMap((p) => p.milestones ?? []).map((m) => m.id);
    const withProject = rand() < 0.5;
    const res = await owner.post(`${ws}/issues`, {
      teamId: team.id,
      title: `Issue ${i}`,
      stateId: pick(team.states).id,
      priority: Math.floor(rand() * 5),
      assigneeId: rand() < 0.3 ? null : pick(members),
      labelIds: rand() < 0.4 ? [] : some(labels, 2),
      projectId: withProject ? project.id : null,
      milestoneId: withProject && rand() < 0.5 ? pick(milestones) : null,
      cycleId: rand() < 0.5 && cycles.length ? pick(cycles) : null,
    });
    expect(res.statusCode, res.body).toBe(200);
    const fate = rand();
    if (fate < 0.1) await owner.post(`${ws}/issues/${res.data.id}/archive`);
    else if (fate < 0.2) await owner.post(`${ws}/issues/batch-delete`, { ids: [res.data.id] });
  }
});
afterAll(() => app.close());

function randomFilter(): IssueFilter {
  const f: IssueFilter = {};
  const states = boot.teams.flatMap((t) => t.states);
  const people = [...boot.members.map((m) => m.id), 'me'];
  const projects = boot.projects.map((p) => p.id);
  const milestones = boot.projects.flatMap((p) => p.milestones ?? []).map((m) => m.id);
  if (rand() < 0.3) f.teamId = pick(boot.teams).id;
  if (rand() < 0.3) f.stateIds = some(states.map((s) => s.id));
  if (rand() < 0.3)
    f.stateTypes = some([
      'triage',
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ] as StateType[]);
  if (rand() < 0.3) f.priorities = some([0, 1, 2, 3, 4]);
  if (rand() < 0.3) f.assigneeIds = some([...people, 'none']);
  if (rand() < 0.2) f.creatorIds = some(people);
  if (rand() < 0.3) f.labelIds = some(boot.labels.map((l) => l.id));
  if (rand() < 0.3) f.projectIds = some([...projects, 'none']);
  if (rand() < 0.2) f.milestoneIds = some([...milestones, 'none']);
  if (rand() < 0.3) f.cycleIds = some([...boot.cycles.map((c) => c.id), 'none']);
  const r = rand();
  if (r < 0.1) f.trashed = true;
  else if (r < 0.2) f.archived = 'include';
  else if (r < 0.3) f.archived = 'only';
  return f;
}

describe('matchIssue', () => {
  it('picks the same issues as the server for 300 random filters', async () => {
    const access = await computeAccess(app.db, ownerId, boot.workspace.id, 'owner');
    const all = await workspaceIssuePage(app.db, boot.workspace.id, null, 10_000);
    const types = new Map(boot.teams.flatMap((t) => t.states).map((s) => [s.id, s.type]));
    const ctx = { userId: ownerId, stateType: (id: string) => types.get(id) };
    let telling = 0;
    for (let i = 0; i < 300; i++) {
      const filter = randomFilter();
      const server = (await queryIssues(app.db, access, filter, 10_000)).map((x) => x.id).sort();
      const local = all
        .filter((x) => matchIssue(x, filter, ctx))
        .map((x) => x.id)
        .sort();
      expect(local, JSON.stringify(filter)).toEqual(server);
      if (server.length > 0 && server.length < all.length) telling++;
    }
    // Most filters pick some issues but not all, so agreeing means something.
    expect(telling).toBeGreaterThan(150);
  });
});
