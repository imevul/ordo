import type { Bootstrap, Issue, IssueDetail } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKey } from '../src/routes/auth.ts';
import { extractMentions } from '../src/services/comments.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let ada: Client;
let grace: Client;
let graceId: string;
let boot: Bootstrap;
const ws = '/api/w/acme';

beforeAll(async () => {
  app = await testApp();
  ada = (await signup(app, 'Ada Lovelace')).client;
  const created = await ada.post('/api/workspaces', {
    name: 'Acme',
    slug: 'acme',
    teamName: 'Engineering',
    teamKey: 'ENG',
  });
  expect(created.statusCode).toBe(200);

  const invite = await ada.post(`${ws}/invites`, {});
  expect(invite.statusCode).toBe(200);
  const g = await signup(app, 'Grace Hopper', { inviteToken: invite.data[0].token });
  grace = g.client;
  expect(g.data.workspaceSlug).toBe('acme');
  graceId = (await grace.get('/api/auth/me')).data.id;
  boot = (await ada.get(`${ws}/bootstrap`)).data;
});

afterAll(async () => {
  await app.close();
});

const team = () => boot.teams[0]!;
const state = (type: string) => team().states.find((s) => s.type === type)!;

describe('auth & workspaces', () => {
  it('reports instance config', async () => {
    const res = await ada.get('/api/config');
    expect(res.data).toMatchObject({ hasUsers: true, signupMode: 'open' });
  });

  it('rejects unauthenticated workspace access', async () => {
    const res = await app.inject({ method: 'GET', url: `${ws}/bootstrap` });
    expect(res.statusCode).toBe(401);
  });

  it('hides workspaces from non-members', async () => {
    const outsider = (await signup(app, 'Eve Outsider')).client;
    expect((await outsider.get(`${ws}/bootstrap`)).statusCode).toBe(404);
  });

  it('bootstraps the workspace with a default team and workflow', () => {
    expect(boot.workspace.slug).toBe('acme');
    expect(boot.role).toBe('owner');
    expect(boot.members).toHaveLength(2);
    expect(team().key).toBe('ENG');
    expect(team().states.map((s) => s.type)).toContain('completed');
    expect(team().defaultStateId).toBe(state('backlog').id);
  });

  it('rejects bad credentials', async () => {
    const res = await ada.post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'whatever',
    });
    expect(res.statusCode).toBe(401);
  });

  it('issues API keys that authenticate requests', async () => {
    const key = await ada.post('/api/me/api-keys', { name: 'cli' });
    expect(key.data.token).toMatch(/^ordo_/);
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${key.data.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces[0].slug).toBe('acme');
  });

  it('enforces invite-only signups', async () => {
    const closed = await (await import('./helpers.ts')).testApp({
      settingsFromEnv: { signupMode: 'invite' },
    });
    const res = await closed.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        name: 'Mallory',
        email: `mallory-${Date.now()}@example.com`,
        password: 'password123',
      },
    });
    expect(res.statusCode).toBe(403);
    await closed.close();
  });
});

describe('issues', () => {
  let first: Issue;

  it('creates issues with sequential identifiers', async () => {
    const a = await ada.post(`${ws}/issues`, { teamId: team().id, title: 'Set up CI' });
    const b = await ada.post(`${ws}/issues`, {
      teamId: team().id,
      title: 'Write docs',
      priority: 2,
    });
    expect(a.statusCode).toBe(200);
    first = a.data;
    expect(a.data.identifier).toBe('ENG-1');
    expect(b.data.identifier).toBe('ENG-2');
    expect(a.data.stateId).toBe(state('backlog').id);
  });

  it('fetches an issue by identifier', async () => {
    const res = await ada.get(`${ws}/issues/ENG-1`);
    expect(res.data.id).toBe(first.id);
    expect(res.data.subscriberIds).toContain(res.data.creatorId);
  });

  it('records history, timestamps and notifications on update', async () => {
    const res = await ada.patch(`${ws}/issues/${first.id}`, {
      stateId: state('started').id,
      assigneeId: graceId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.startedAt).not.toBeNull();
    const history = (await ada.get(`${ws}/issues/${first.id}/history`)).data;
    expect(
      history
        .at(-1)
        .changes.map((c: { field: string }) => c.field)
        .sort(),
    ).toEqual(['assignee', 'state']);
    const inbox = (await grace.get(`${ws}/notifications`)).data;
    expect(inbox[0]).toMatchObject({ type: 'issue_assigned', issueId: first.id });
  });

  it('filters issues', async () => {
    const mine = (await grace.post(`${ws}/issues/query`, { filter: { assigneeIds: ['me'] } }))
      .data as Issue[];
    expect(mine.map((i) => i.identifier)).toEqual(['ENG-1']);
    const high = (await ada.post(`${ws}/issues/query`, { filter: { priorities: [2] } }))
      .data as Issue[];
    expect(high.map((i) => i.identifier)).toEqual(['ENG-2']);
    const started = (await ada.post(`${ws}/issues/query`, { filter: { stateTypes: ['started'] } }))
      .data as Issue[];
    expect(started).toHaveLength(1);
    const search = (await ada.post(`${ws}/issues/query`, { filter: { q: 'eng-2' } }))
      .data as Issue[];
    expect(search[0]?.title).toBe('Write docs');
  });

  it('manages labels on issues', async () => {
    const label = (await ada.post(`${ws}/labels`, { name: 'Bug', color: '#ef4444' })).data;
    const res = await ada.patch(`${ws}/issues/${first.id}`, { addLabelIds: [label.id] });
    expect(res.data.labelIds).toEqual([label.id]);
    const byLabel = (await ada.post(`${ws}/issues/query`, { filter: { labelIds: [label.id] } }))
      .data as Issue[];
    expect(byLabel.map((i) => i.id)).toEqual([first.id]);
  });

  it('supports sub-issues and rejects loops', async () => {
    const child = (
      await ada.post(`${ws}/issues`, { teamId: team().id, title: 'Child', parentId: first.id })
    ).data as Issue;
    const detail = (await ada.get(`${ws}/issues/${first.id}`)).data as IssueDetail;
    expect(detail.subIssues.map((s) => s.id)).toEqual([child.id]);
    expect(detail.subIssueCount).toBe(1);
    const loop = await ada.patch(`${ws}/issues/${first.id}`, { parentId: child.id });
    expect(loop.statusCode).toBe(400);
  });

  it('creates mirrored relations', async () => {
    const other = (await ada.get(`${ws}/issues/ENG-2`)).data as IssueDetail;
    const rel = await ada.post(`${ws}/issues/${first.id}/relations`, {
      type: 'blocked_by',
      relatedIssueId: other.id,
    });
    expect(rel.statusCode).toBe(200);
    const a = (await ada.get(`${ws}/issues/${first.id}`)).data as IssueDetail;
    const b = (await ada.get(`${ws}/issues/${other.id}`)).data as IssueDetail;
    expect(a.relations[0]).toMatchObject({ type: 'blocked_by', issue: { id: other.id } });
    expect(b.relations[0]).toMatchObject({ type: 'blocks', issue: { id: first.id } });
  });

  it('notifies on mentions in comments', async () => {
    const graceMe = (await grace.get('/api/auth/me')).data;
    const res = await ada.post(`${ws}/issues/ENG-2/comments`, {
      body: `Can you look, @${graceMe.username}?`,
    });
    expect(res.statusCode).toBe(200);
    const inbox = (await grace.get(`${ws}/notifications`)).data;
    expect(inbox[0]).toMatchObject({ type: 'issue_mention' });
  });

  it('moves issues between teams with a new identifier', async () => {
    const ops = (await ada.post(`${ws}/teams`, { name: 'Operations', key: 'OPS' })).data;
    const moved = await ada.patch(`${ws}/issues/ENG-2`, { teamId: ops.id });
    expect(moved.data.identifier).toBe('OPS-1');
    expect(ops.states.map((s: { id: string }) => s.id)).toContain(moved.data.stateId);
  });

  it('trashes and restores issues', async () => {
    await ada.del(`${ws}/issues/${first.id}`);
    const live = (await ada.post(`${ws}/issues/query`, { filter: {} })).data as Issue[];
    expect(live.some((i) => i.id === first.id)).toBe(false);
    const trash = (await ada.post(`${ws}/issues/query`, { filter: { trashed: true } }))
      .data as Issue[];
    expect(trash.map((i) => i.id)).toContain(first.id);
    await ada.post(`${ws}/issues/${first.id}/restore`);
    const back = (await ada.post(`${ws}/issues/query`, { filter: {} })).data as Issue[];
    expect(back.some((i) => i.id === first.id)).toBe(true);
  });

  it('bulk-updates issues', async () => {
    const all = (await ada.post(`${ws}/issues/query`, { filter: { teamId: team().id } }))
      .data as Issue[];
    const res = await ada.post(`${ws}/issues/batch`, {
      ids: all.map((i) => i.id),
      patch: { priority: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.data as Issue[]).every((i) => i.priority === 1)).toBe(true);
  });
});

describe('projects, cycles & views', () => {
  it('computes project progress', async () => {
    const project = (await ada.post(`${ws}/projects`, { name: 'Launch', teamIds: [team().id] }))
      .data;
    const issue = (
      await ada.post(`${ws}/issues`, {
        teamId: team().id,
        title: 'Ship it',
        projectId: project.id,
        estimate: 3,
      })
    ).data;
    await ada.patch(`${ws}/issues/${issue.id}`, { stateId: state('completed').id });
    await ada.post(`${ws}/issues`, { teamId: team().id, title: 'Announce', projectId: project.id });
    const p = (await ada.get(`${ws}/projects/${project.id}`)).data;
    expect(p.progress).toMatchObject({ total: 2, completed: 1, completedEstimate: 3 });
    await ada.post(`${ws}/projects/${project.id}/updates`, {
      body: 'Going well',
      health: 'on_track',
    });
    expect((await ada.get(`${ws}/projects/${project.id}`)).data.health).toBe('on_track');
  });

  it('numbers cycles per team and validates dates', async () => {
    const c1 = await ada.post(`${ws}/teams/${team().id}/cycles`, {
      startsAt: '2026-01-05',
      endsAt: '2026-01-19',
    });
    const c2 = await ada.post(`${ws}/teams/${team().id}/cycles`, {
      startsAt: '2026-01-19',
      endsAt: '2026-02-02',
    });
    expect([c1.data.number, c2.data.number]).toEqual([1, 2]);
    const bad = await ada.post(`${ws}/teams/${team().id}/cycles`, {
      startsAt: '2026-02-02',
      endsAt: '2026-02-01',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('saves views; private views stay private', async () => {
    const v = await ada.post(`${ws}/views`, {
      name: 'Urgent',
      shared: false,
      filters: { priorities: [1] },
    });
    expect(v.statusCode).toBe(200);
    const graceBoot = (await grace.get(`${ws}/bootstrap`)).data as Bootstrap;
    expect(graceBoot.views.some((x) => x.id === v.data.id)).toBe(false);
    expect((await grace.patch(`${ws}/views/${v.data.id}`, { name: 'Mine now' })).statusCode).toBe(
      404,
    );
  });

  it('only lets admins manage invites', async () => {
    expect((await grace.post(`${ws}/invites`, {})).statusCode).toBe(403);
  });
});

describe('helpers', () => {
  it('extracts mentions', () => {
    expect(extractMentions('hi @ada and @grace.h, not email@x.com')).toEqual(['ada', 'grace.h']);
  });
  it('derives team keys', () => {
    expect(deriveKey('Engineering')).toBe('ENG');
    expect(deriveKey('Platform Infra Team')).toBe('PIT');
  });
});
