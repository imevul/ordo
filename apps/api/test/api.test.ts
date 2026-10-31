import { randomUUID } from 'node:crypto';
import type { Bootstrap, HistoryEntry, Issue, IssueDetail } from '@ordo/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema.ts';
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
    // The update also notifies about the status change, at the same instant, so order is arbitrary.
    expect(inbox).toContainEqual(
      expect.objectContaining({ type: 'issue_assigned', issueId: first.id }),
    );
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

  it('pages through issues with a cursor', async () => {
    const all = (await ada.post(`${ws}/issues/query`, { filter: {} })).data as Issue[];
    expect(all.length).toBeGreaterThan(1);
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = (await ada.post(`${ws}/issues/query`, { filter: {}, after, limit: 1 }))
        .data as Issue[];
      seen.push(...page.map((i) => i.id));
      if (page.length < 1) break;
      after = page[0]!.id;
    }
    expect(seen).toEqual(all.map((i) => i.id).sort());
    const bad = await ada.post(`${ws}/issues/query`, { filter: {}, after: 'nope' });
    expect(bad.statusCode).toBe(400);
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

    // Pages and links opened before the move still find it, in any later team too.
    expect((await ada.get(`${ws}/issues/ENG-2`)).data).toMatchObject({
      id: moved.data.id,
      identifier: 'OPS-1',
    });
    const back = await ada.patch(`${ws}/issues/OPS-1`, { teamId: team().id });
    expect(back.data.identifier).not.toBe('ENG-2');
    for (const old of ['ENG-2', 'ops-1'])
      expect((await ada.get(`${ws}/issues/${old}`)).data).toMatchObject({
        id: moved.data.id,
        identifier: back.data.identifier,
      });
    expect((await ada.get(`${ws}/issues/OPS-2`)).statusCode).toBe(404);
  });

  describe('status on a team move', () => {
    let target: Bootstrap['teams'][number];
    const targetState = (type: string) => target.states.find((s) => s.type === type)!;
    const lastChanges = async (id: string) =>
      (await ada.get(`${ws}/issues/${id}/history`)).data.at(-1).changes as {
        field: string;
        from: unknown;
        to: unknown;
      }[];
    const lastEvent = async (id: string) =>
      (
        await app.db
          .select()
          .from(domainEvents)
          .where(
            and(eq(domainEvents.type, 'issue.updated'), sql`${domainEvents.data}->>'id' = ${id}`),
          )
          .orderBy(desc(domainEvents.id))
          .limit(1)
      )[0]!;
    const statusNotices = async (id: string) =>
      ((await grace.get(`${ws}/notifications`)).data as { type: string; issueId: string }[]).filter(
        (n) => n.type === 'issue_status_changed' && n.issueId === id,
      ).length;

    beforeAll(async () => {
      target = (await ada.post(`${ws}/teams`, { name: 'Support', key: 'SUP' })).data;
    });

    it('treats completed → completed as a status change and keeps when it was done', async () => {
      const issue = (
        await ada.post(`${ws}/issues`, {
          teamId: team().id,
          title: 'Done elsewhere',
          stateId: state('completed').id,
          assigneeId: graceId,
        })
      ).data as Issue;
      expect(issue.completedAt).not.toBeNull();
      const before = await statusNotices(issue.id);

      const moved = (await ada.patch(`${ws}/issues/${issue.id}`, { teamId: target.id }))
        .data as Issue;
      expect(moved.stateId).toBe(targetState('completed').id);
      expect(moved.startedAt).toBe(issue.startedAt);
      expect(moved.completedAt).toBe(issue.completedAt);
      expect(moved.canceledAt).toBeNull();

      const stateChange = { field: 'state', from: issue.stateId, to: moved.stateId };
      expect(await lastChanges(issue.id)).toContainEqual(stateChange);
      expect((await lastEvent(issue.id)).changes).toContainEqual(stateChange);
      expect(await statusNotices(issue.id)).toBe(before + 1);
    });

    it('treats started → completed as a status change and stamps completedAt', async () => {
      const issue = (
        await ada.post(`${ws}/issues`, {
          teamId: team().id,
          title: 'Finish elsewhere',
          stateId: state('started').id,
          assigneeId: graceId,
        })
      ).data as Issue;
      expect(issue.startedAt).not.toBeNull();
      expect(issue.completedAt).toBeNull();
      const before = await statusNotices(issue.id);

      const moved = (
        await ada.patch(`${ws}/issues/${issue.id}`, {
          teamId: target.id,
          stateId: targetState('completed').id,
        })
      ).data as Issue;
      expect(moved.stateId).toBe(targetState('completed').id);
      expect(moved.startedAt).toBe(issue.startedAt);
      expect(moved.completedAt).not.toBeNull();
      expect(moved.canceledAt).toBeNull();

      const stateChange = { field: 'state', from: issue.stateId, to: moved.stateId };
      expect(await lastChanges(issue.id)).toContainEqual(stateChange);
      expect((await lastEvent(issue.id)).changes).toContainEqual(stateChange);
      expect(await statusNotices(issue.id)).toBe(before + 1);
    });

    it('clears completedAt when a move lands on a status of another type', async () => {
      const issue = (
        await ada.post(`${ws}/issues`, {
          teamId: team().id,
          title: 'Reopen elsewhere',
          stateId: state('completed').id,
        })
      ).data as Issue;
      const moved = (
        await ada.patch(`${ws}/issues/${issue.id}`, {
          teamId: target.id,
          stateId: targetState('started').id,
        })
      ).data as Issue;
      expect(moved.completedAt).toBeNull();
      expect(moved.startedAt).toBe(issue.startedAt);
      const done = (
        await ada.patch(`${ws}/issues/${issue.id}`, { stateId: targetState('completed').id })
      ).data as Issue;
      expect(done.completedAt).not.toBeNull();
      expect(done.completedAt).not.toBe(issue.completedAt);
    });

    it('maps an unchanged status from the old team by type', async () => {
      const issue = (
        await ada.post(`${ws}/issues`, {
          teamId: team().id,
          title: 'Resent form',
          stateId: state('started').id,
        })
      ).data as Issue;
      const moved = (
        await ada.patch(`${ws}/issues/${issue.id}`, {
          teamId: target.id,
          stateId: issue.stateId,
        })
      ).data as Issue;
      expect(moved.teamId).toBe(target.id);
      expect(moved.stateId).toBe(targetState('started').id);
      expect(moved.startedAt).toBe(issue.startedAt);
      expect(await lastChanges(issue.id)).toContainEqual({
        field: 'state',
        from: issue.stateId,
        to: moved.stateId,
      });
      const board = (await ada.post(`${ws}/issues/query`, { filter: { teamId: target.id } }))
        .data as Issue[];
      expect(board.some((i) => i.id === issue.id)).toBe(true);
    });

    it('maps another status of the old team by its type', async () => {
      const issue = (
        await ada.post(`${ws}/issues`, {
          teamId: team().id,
          title: 'Moved and finished',
          stateId: state('started').id,
        })
      ).data as Issue;
      const moved = (
        await ada.patch(`${ws}/issues/${issue.id}`, {
          teamId: target.id,
          stateId: state('completed').id,
        })
      ).data as Issue;
      expect(moved.stateId).toBe(targetState('completed').id);
      expect(moved.startedAt).toBe(issue.startedAt);
      expect(moved.completedAt).not.toBeNull();
    });

    it("rejects a third team's status on a move", async () => {
      const third = (await ada.post(`${ws}/teams`, { name: 'Design', key: 'DES' }))
        .data as Bootstrap['teams'][number];
      const issue = (await ada.post(`${ws}/issues`, { teamId: team().id, title: 'Lost' }))
        .data as Issue;
      const res = await ada.patch(`${ws}/issues/${issue.id}`, {
        teamId: target.id,
        stateId: third.states[0]!.id,
      });
      expect(res.statusCode).toBe(400);
      const after = (await ada.get(`${ws}/issues/${issue.id}`)).data as Issue;
      expect(after.teamId).toBe(team().id);
    });
  });

  it('trashes and restores issues', async () => {
    expect((await ada.del(`${ws}/issues/${first.id}`)).statusCode).toBe(200);
    const live = (await ada.post(`${ws}/issues/query`, { filter: {} })).data as Issue[];
    expect(live.some((i) => i.id === first.id)).toBe(false);
    const trash = (await ada.post(`${ws}/issues/query`, { filter: { trashed: true } }))
      .data as Issue[];
    expect(trash.map((i) => i.id)).toContain(first.id);
    const restored = (await ada.post(`${ws}/issues/${first.id}/restore`)).data as Issue;
    expect(restored).toMatchObject({ id: first.id, identifier: first.identifier, deletedAt: null });
    const back = (await ada.post(`${ws}/issues/query`, { filter: {} })).data as Issue[];
    expect(back.some((i) => i.id === first.id)).toBe(true);
  });

  it('bulk-updates issues', async () => {
    const all = (await ada.post(`${ws}/issues/query`, { filter: { teamId: team().id } }))
      .data as Issue[];
    expect(all.some((i) => i.priority !== 1)).toBe(true);
    const ids = all.map((i) => i.id);
    const res = await ada.post(`${ws}/issues/batch`, { ids, patch: { priority: 1 } });
    expect(res.statusCode).toBe(200);
    expect((res.data as Issue[]).map((i) => i.id)).toEqual(ids);
    expect((res.data as Issue[]).every((i) => i.priority === 1)).toBe(true);
    for (const before of all) {
      const saved = (await ada.get(`${ws}/issues/${before.id}`)).data as Issue;
      expect(saved.priority).toBe(1);
      if (before.priority === 1) continue;
      const history = (await ada.get(`${ws}/issues/${before.id}/history`)).data as HistoryEntry[];
      expect(history.flatMap((h) => h.changes)).toContainEqual({
        field: 'priority',
        from: before.priority,
        to: 1,
      });
    }

    // One unknown id fails the whole batch: nothing is half-applied.
    const mixed = await ada.post(`${ws}/issues/batch`, {
      ids: [ids[0], randomUUID()],
      patch: { priority: 3 },
    });
    expect(mixed.statusCode).toBe(404);
    expect(((await ada.get(`${ws}/issues/${ids[0]}`)).data as Issue).priority).toBe(1);
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
