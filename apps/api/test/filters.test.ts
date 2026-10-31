import { addDays, type Bootstrap, type Issue, type IssueFilter } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueLinks } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';

/**
 * The richer issue filters through the API. Conditions the local copy can also answer are
 * compared with `matchIssue` in sync-match.test.ts; relations and links are only checked here.
 */

let app: FastifyInstance;
let owner: Client;
let boot: Bootstrap;
const slug = `filters-${Date.now()}`;
const ws = `/api/w/${slug}`;
const today = new Date().toISOString().slice(0, 10);
const byTitle: Record<string, Issue> = {};

const state = (type: string) => boot.teams[0]!.states.find((s) => s.type === type)!;
const titles = async (filter: IssueFilter) => {
  const res = await owner.post(`${ws}/issues/query`, { filter });
  expect(res.statusCode, res.body).toBe(200);
  return (res.data as Issue[]).map((i) => i.title).sort();
};

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Filter Owner')).client;
  await owner.post('/api/workspaces', { name: 'Filters', slug, teamName: 'One', teamKey: 'ONE' });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  const add = async (title: string, extra: Record<string, unknown> = {}) => {
    const res = await owner.post(`${ws}/issues`, { teamId: boot.teams[0]!.id, title, ...extra });
    expect(res.statusCode, res.body).toBe(200);
    byTitle[title] = res.data;
  };
  await add('late', { dueDate: addDays(today, -3), estimate: 3, stateId: state('started').id });
  await add('late but done', { dueDate: addDays(today, -3), stateId: state('completed').id });
  await add('soon', { dueDate: addDays(today, 5), estimate: 8 });
  await add('blocker', { stateId: state('started').id });
  await add('no dates');
  await add('child', { parentId: byTitle['no dates']!.id, estimate: 1 });
  // "blocker" blocks "late"; the done issue blocks "soon", which doesn't count.
  await owner.post(`${ws}/issues/${byTitle.blocker!.id}/relations`, {
    type: 'blocks',
    relatedIssueId: byTitle.late!.id,
  });
  await owner.post(`${ws}/issues/${byTitle['late but done']!.id}/relations`, {
    type: 'blocks',
    relatedIssueId: byTitle.soon!.id,
  });
  await app.db.insert(issueLinks).values({
    workspaceId: boot.workspace.id,
    issueId: byTitle.soon!.id,
    provider: 'github',
    kind: 'pull_request',
    externalId: 'PR_1',
    url: 'https://github.com/acme/app/pull/1',
    title: 'Ship it',
  });
});
afterAll(() => app.close());

describe('issue filters', () => {
  it('filters by relative and absolute dates', async () => {
    expect(await titles({ dueDate: { range: 'overdue' } })).toEqual(['late']);
    expect(await titles({ dueDate: { range: 'next14Days' } })).toEqual(['soon']);
    expect(await titles({ dueDate: { range: 'none' } })).toEqual(['blocker', 'child', 'no dates']);
    expect(await titles({ dueDate: { from: addDays(today, -5), to: today } })).toEqual([
      'late',
      'late but done',
    ]);
    expect(await titles({ createdAt: { range: 'today' } })).toHaveLength(6);
    expect(await titles({ completedAt: { range: 'last7Days' } })).toEqual(['late but done']);
  });

  it('filters by estimate', async () => {
    expect(await titles({ estimate: { none: true } })).toEqual([
      'blocker',
      'late but done',
      'no dates',
    ]);
    expect(await titles({ estimate: { min: 3 } })).toEqual(['late', 'soon']);
    expect(await titles({ estimate: { none: true, max: 1 } })).toEqual([
      'blocker',
      'child',
      'late but done',
      'no dates',
    ]);
  });

  it('filters by relations, pull requests and sub-issues', async () => {
    expect(await titles({ blocked: true })).toEqual(['late']);
    expect(await titles({ blocking: true })).toEqual(['blocker']);
    expect(await titles({ blocked: false, dueDate: { range: 'any' } })).toEqual([
      'late but done',
      'soon',
    ]);
    expect(await titles({ hasPullRequest: true })).toEqual(['soon']);
    expect(await titles({ hasSubIssues: true })).toEqual(['no dates']);
    expect(await titles({ isSubIssue: true })).toEqual(['child']);
    expect(await titles({ isSubIssue: false, hasSubIssues: false, blocked: false })).toEqual([
      'blocker',
      'late but done',
      'soon',
    ]);
  });

  it('combines "is not" and "or" groups', async () => {
    // "Overdue and not blocked" finds nothing: the one overdue issue is blocked.
    expect(await titles({ dueDate: { range: 'overdue' }, exclude: { blocked: true } })).toEqual([]);
    // An unset date isn't "today", so "is not today" keeps issues without one.
    expect(await titles({ exclude: { dueDate: { range: 'next14Days' } } })).toEqual([
      'blocker',
      'child',
      'late',
      'late but done',
      'no dates',
    ]);
    expect(await titles({ or: [{ hasPullRequest: true }, { isSubIssue: true }] })).toEqual([
      'child',
      'soon',
    ]);
    expect(
      await titles({
        stateTypes: ['backlog', 'unstarted', 'started'],
        or: [{ blocked: true }, { exclude: { estimate: {} } }],
      }),
    ).toEqual(['blocker', 'late', 'no dates']);
  });

  it('rejects malformed and too deeply nested filters', async () => {
    let deep: Record<string, unknown> = { blocked: true };
    for (let i = 0; i < 6; i++) deep = { exclude: deep };
    for (const filter of [
      deep,
      { dueDate: { range: 'someday' } },
      { estimate: { min: -1 } },
      { tz: 'Mars/Olympus' },
      // Postgres would read an offset the POSIX way, an hour the other side of UTC.
      { tz: '+01:00' },
      { or: [{ assigneeIds: ['nope'] }] },
    ]) {
      const res = await owner.post(`${ws}/issues/query`, { filter });
      expect(res.statusCode, JSON.stringify(filter)).toBe(400);
    }
    // Old names Intl still maps reach Postgres as their canonical zone.
    expect(await titles({ tz: 'US/Pacific-New', createdAt: { range: 'last7Days' } })).toHaveLength(
      6,
    );
  });

  it('negates custom fields and puts them in "or" groups', async () => {
    const field = (
      await owner.post(`${ws}/custom-fields`, {
        name: 'Tier',
        type: 'select',
        options: [{ name: 'Gold' }, { name: 'Silver' }],
      })
    ).data;
    const [gold, silver] = field.options.map((o: { id: string }) => o.id);
    await owner.patch(`${ws}/issues/${byTitle.late!.id}`, { customFields: { [field.id]: gold } });
    await owner.patch(`${ws}/issues/${byTitle.soon!.id}`, { customFields: { [field.id]: silver } });
    expect(await titles({ customFields: { [field.id]: [gold] } })).toEqual(['late']);
    // "Is not Gold" keeps issues without a tier, like every other "is not".
    expect(await titles({ exclude: { customFields: { [field.id]: [gold] } } })).toEqual([
      'blocker',
      'child',
      'late but done',
      'no dates',
      'soon',
    ]);
    expect(await titles({ exclude: { customFields: { [field.id]: ['none'] } } })).toEqual([
      'late',
      'soon',
    ]);
    expect(
      await titles({ or: [{ customFields: { [field.id]: [silver] } }, { isSubIssue: true }] }),
    ).toEqual(['child', 'soon']);
  });
});
