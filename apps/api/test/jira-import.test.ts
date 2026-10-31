import type { Bootstrap, CustomField, Import, IssueDetail } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comments, issueRelations, issues, projects } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { type ForgeRequest, startMockForge } from './mock-forge.ts';

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let bobEmail: string;
let bobId: string;
let severity: CustomField;
const slug = `jira-${Date.now()}`;
const ws = `/api/w/${slug}`;
const EMAIL = 'admin@acme.test';
const TOKEN = 'jira_api_token_0123456789';
const PAT = 'jira_personal_access_token_0123';

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

// ─── a small Jira ─────────────────────────────────────────────────────────

const user = (id: string, name: string, email?: string) => ({
  accountId: id,
  displayName: name,
  ...(email && { emailAddress: email }),
});
const status = (name: string, category: string) => ({ name, statusCategory: { key: category } });
const type = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });
const comment = (id: string, author: ReturnType<typeof user>, body: string, created: string) => ({
  id,
  author,
  body,
  created,
});

function jiraIssue(key: string, fields: Record<string, unknown>) {
  return {
    id: key,
    key,
    fields: {
      summary: key,
      description: null,
      status: status('To Do', 'new'),
      priority: { name: 'Medium' },
      assignee: null,
      reporter: null,
      creator: null,
      labels: [],
      components: [],
      issuetype: type('Task'),
      parent: null,
      created: '2024-01-02T10:00:00.000+0000',
      updated: '2024-01-25T10:00:00.000+0000',
      resolutiondate: null,
      duedate: null,
      comment: { comments: [], total: 0 },
      issuelinks: [],
      ...fields,
    },
  };
}

let bob: ReturnType<typeof user>;
const alice = user('acc-alice', 'Alice Reporter');
const carol = user('acc-carol', 'Carol Commenter');
const extraComments: Record<string, unknown[]> = {};

function data() {
  bob = user('acc-bob', 'Bob Member', bobEmail);
  const epic = {
    key: 'ENG-1',
    fields: { summary: 'Q1 launch', issuetype: type('Epic', { hierarchyLevel: 1 }) },
  };
  const story = { key: 'ENG-2', fields: { summary: 'Login page', issuetype: type('Story') } };
  extraComments['ENG-2'] = [comment('c3', carol, 'Shipped?', '2024-01-12T10:00:00.000+0000')];
  return [
    jiraIssue('ENG-1', {
      summary: 'Q1 launch',
      issuetype: type('Epic', { hierarchyLevel: 1 }),
      status: status('In Progress', 'indeterminate'),
      assignee: bob,
    }),
    jiraIssue('ENG-2', {
      summary: 'Login page',
      description: 'h2. Goal\nUsers *log in*',
      issuetype: type('Story'),
      status: status('In Review', 'indeterminate'),
      priority: { name: 'High' },
      assignee: bob,
      reporter: alice,
      labels: ['frontend'],
      components: [{ name: 'Web' }],
      parent: epic,
      customfield_10016: 5,
      customfield_10020: [{ id: 7, name: 'Sprint 7' }],
      customfield_10100: { id: '1', value: 'High' },
      customfield_10101: [{ value: 'Acme' }, { value: 'Globex' }],
      customfield_10102: 1200.5,
      customfield_10103: '2024-04-30T23:30:00.000-0700',
      customfield_10104: 'Needs legal review',
      customfield_10105: carol,
      duedate: '2024-03-01',
      created: '2024-01-05T10:00:00.000+0000',
      comment: {
        total: 3,
        comments: [
          comment('c1', bob, 'Looks *good*', '2024-01-10T10:00:00.000+0000'),
          comment('c2', alice, 'Thanks', '2024-01-11T10:00:00.000+0000'),
        ],
      },
    }),
    jiraIssue('ENG-3', {
      summary: 'Validate email',
      issuetype: type('Sub-task', { subtask: true }),
      status: status('Done', 'done'),
      resolutiondate: '2024-01-20T10:00:00.000+0000',
      parent: story,
    }),
    jiraIssue('ENG-4', {
      summary: 'Crash',
      issuetype: type('Bug'),
      status: status("Won't Do", 'done'),
      resolutiondate: '2024-01-21T10:00:00.000+0000',
      customfield_10100: { id: '2', value: 'Low' },
      customfield_10101: [],
      customfield_10106: null,
      issuelinks: [
        { id: 'L1', type: { name: 'Blocks' }, outwardIssue: { key: 'ENG-2' } },
        { id: 'L2', type: { name: 'Duplicate' }, outwardIssue: { key: 'ENG-3' } },
      ],
    }),
    // Data Center links issues to epics with the "Epic Link" field rather than `parent`.
    jiraIssue('OPS-1', { summary: 'Ops epic', issuetype: type('Epic') }),
    jiraIssue('OPS-2', { summary: 'Ops 2', customfield_10014: 'OPS-1' }),
    jiraIssue('OPS-3', { summary: 'Ops 3' }),
  ];
}

const cf = (id: string, name: string, type: string, custom: string, items?: string) => ({
  id,
  name,
  custom: true,
  schema: {
    type,
    ...(items && { items }),
    custom: custom.includes(':')
      ? custom
      : `com.atlassian.jira.plugin.system.customfieldtypes:${custom}`,
  },
});

/** Two issues a page: token paging on Cloud's /search/jql, offsets on Data Center's /search. */
function jira(req: ForgeRequest) {
  const basic = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
  if (req.headers.authorization !== basic && req.headers.authorization !== `Bearer ${PAT}`) {
    return { status: 401, body: { errorMessages: ['Unauthorized'] } };
  }
  const url = new URL(req.path, 'http://x');
  const path = url.pathname;
  if (path === '/rest/api/2/myself') return { body: { displayName: 'Admin' } };
  if (path === '/rest/api/2/project') {
    return {
      body: [
        { key: 'ENG', name: 'Engineering' },
        { key: 'OPS', name: 'Operations' },
      ],
    };
  }
  if (path === '/rest/api/2/field') {
    return {
      body: [
        { id: 'customfield_10016', name: 'Story point estimate' },
        { id: 'customfield_10014', name: 'Epic Link' },
        { id: 'summary', name: 'Summary' },
        { id: 'labels', name: 'Labels', custom: false, schema: { type: 'array', items: 'string' } },
        cf('customfield_10020', 'Sprint', 'array', 'com.pyxis.greenhopper.jira:gh-sprint', 'json'),
        cf('customfield_10100', 'Severity', 'option', 'select'),
        cf('customfield_10101', 'Customers', 'array', 'multiselect', 'option'),
        cf('customfield_10102', 'Budget', 'number', 'float'),
        cf('customfield_10103', 'Go-live', 'datetime', 'datetime'),
        cf('customfield_10104', 'Notes', 'string', 'textarea'),
        cf('customfield_10105', 'Reviewer', 'user', 'userpicker'),
        // No issue has a value: no field is made for it.
        cf('customfield_10106', 'Unused', 'string', 'textfield'),
      ],
    };
  }
  const more = /^\/rest\/api\/2\/issue\/([\w-]+)\/comment$/.exec(path);
  if (more) {
    const start = Number(url.searchParams.get('startAt'));
    const all = data().find((i) => i.key === more[1])!.fields.comment as { comments: unknown[] };
    return {
      body: { comments: [...all.comments, ...(extraComments[more[1]!] ?? [])].slice(start) },
    };
  }
  if (path === '/rest/api/2/search/jql' || path === '/rest/api/2/search') {
    const wanted = [...url.searchParams.get('jql')!.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    const list = data().filter((i) => wanted.includes(i.key.split('-')[0]));
    if (path.endsWith('/jql')) {
      const start = Number(url.searchParams.get('nextPageToken') ?? 0);
      const end = start + 2;
      return {
        body: {
          issues: list.slice(start, end),
          isLast: end >= list.length,
          ...(end < list.length && { nextPageToken: String(end) }),
        },
      };
    }
    const start = Number(url.searchParams.get('startAt'));
    return { body: { issues: list.slice(start, start + 2), total: list.length } };
  }
  return { status: 404, body: { errorMessages: ['Not found'] } };
}

beforeAll(async () => {
  mock = await startMockForge();
  mock.onPrefix('GET', '/rest/api/2/', jira);
  app = await testApp({ settingsFromEnv: { allowPrivateNetworkTargets: true } });
  owner = (await signup(app, 'Olive Owner')).client;
  await owner.post('/api/workspaces', { name: 'Jira', slug, teamName: 'Alpha', teamKey: 'ALP' });
  // Jira's Severity goes into this one rather than a new field.
  severity = (
    await owner.post(`${ws}/custom-fields`, {
      name: 'severity',
      type: 'select',
      options: [{ name: 'Low' }],
    })
  ).data;
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
  const b = await signup(app, 'Bob Member', { inviteToken: invite.token });
  bobEmail = b.email;
  bobId = (await b.client.get('/api/auth/me')).data.id;
});
afterAll(async () => {
  await app.close();
  await mock.close();
});

const start = (body: Record<string, unknown>) =>
  owner.post(`${ws}/imports`, { source: 'jira', siteUrl: mock.url, ...body });
const get = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as IssueDetail;

describe('Jira Cloud import', () => {
  let imp: Import;

  it('checks the credentials and projects', async () => {
    const bad = await start({ email: EMAIL, token: 'wrong_token_12345', projects: ['ENG'] });
    expect(bad.data.message).toContain('Jira refused the credentials');
    const missing = await start({ email: EMAIL, token: TOKEN, projects: ['ENG', 'NOPE'] });
    expect(missing.data.message).toBe("Can't see the project NOPE with these credentials");
  });

  it('analyzes the project, epics and people', async () => {
    const res = await start({ email: EMAIL, token: TOKEN, projects: ['ENG'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.data.name).toBe('Jira: ENG');
    await settle();
    imp = (await owner.get(`${ws}/imports/${res.data.id}`)).data;
    expect(imp.status, imp.error ?? '').toBe('ready');
    const s = imp.summary!;
    // The epic is a project, not an issue; all three comments count.
    expect(s.counts).toEqual({ issues: 3, comments: 3 });
    expect(s.teams).toEqual([
      expect.objectContaining({ id: 'ENG', name: 'Engineering', key: 'ENG', issueCount: 3 }),
    ]);
    expect(Object.fromEntries(s.teams[0]!.statuses.map((x) => [x.name, x.type]))).toEqual({
      'In Review': 'started',
      Done: 'completed',
      "Won't Do": 'canceled',
    });
    expect(s.labels.map((l) => l.name).sort()).toEqual(['Bug', 'Story', 'Web', 'frontend']);
    expect(s.projects).toEqual([
      expect.objectContaining({ id: 'ENG-1', name: 'Q1 launch', status: 'started', count: 1 }),
    ]);
    // Carol only commented, beyond the comments search results carry.
    expect(s.users.map((u) => u.id).sort()).toEqual(['acc-alice', 'acc-bob', 'acc-carol']);
    expect(imp.mapping!.users['acc-bob']).toBe(bobId);
    expect(imp.mapping!.users['acc-carol']).toBe('placeholder');
    // Custom fields with values, but not those Ordo has its own fields for (sprint, story points).
    expect(s.fields).toEqual([
      {
        id: 'customfield_10100',
        name: 'Severity',
        type: 'select',
        count: 2,
        options: ['High', 'Low'],
      },
      {
        id: 'customfield_10101',
        name: 'Customers',
        type: 'multi_select',
        count: 1,
        options: ['Acme', 'Globex'],
      },
      { id: 'customfield_10102', name: 'Budget', type: 'number', count: 1 },
      { id: 'customfield_10103', name: 'Go-live', type: 'date', count: 1 },
      { id: 'customfield_10104', name: 'Notes', type: 'text', count: 1 },
      { id: 'customfield_10105', name: 'Reviewer', type: 'person', count: 1 },
    ]);
    expect(imp.mapping!.fields).toEqual({
      customfield_10100: severity.id,
      customfield_10101: 'create',
      customfield_10102: 'create',
      customfield_10103: 'create',
      customfield_10104: 'create',
      customfield_10105: 'create',
    });
  });

  it('imports issues, sub-tasks, epics, links and comments', async () => {
    await owner.post(`${ws}/imports/${imp.id}/run`);
    await settle(16);
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
    expect(imp.status, imp.error ?? '').toBe('completed');
    expect(imp.report!.created).toMatchObject({
      teams: 1,
      projects: 1,
      issues: 3,
      comments: 3,
      relations: 2,
      fields: 5,
    });

    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const story = await get('ENG-2');
    expect(story).toMatchObject({
      title: 'Login page',
      description: '## Goal\nUsers **log in**',
      priority: 2,
      estimate: 5,
      dueDate: '2024-03-01',
      assigneeId: bobId,
      createdAt: '2024-01-05T10:00:00.000Z',
    });
    expect(story.creatorId).toBe(boot.placeholders.find((p) => p.name === 'Alice Reporter')!.id);
    expect(story.labelIds.map((id) => boot.labels.find((l) => l.id === id)!.name).sort()).toEqual([
      'Story',
      'Web',
      'frontend',
    ]);
    expect(story.links.map((l) => l.url)).toEqual([`${mock.url}/browse/ENG-2`]);

    const fields = Object.fromEntries(
      ((await owner.get(`${ws}/custom-fields`)).data as CustomField[]).map((f) => [f.name, f]),
    );
    expect(Object.keys(fields).sort()).toEqual([
      'Budget',
      'Customers',
      'Go-live',
      'Notes',
      'Reviewer',
      'severity',
    ]);
    expect(fields['Go-live']!.type).toBe('date');
    const option = (name: string, id: unknown) =>
      fields[name]!.options.find((o) => o.id === id)?.name;
    // The existing field got the option it lacked.
    expect(fields.severity!.options.map((o) => o.name)).toEqual(['Low', 'High']);
    expect(option('severity', story.customFields[severity.id])).toBe('High');
    expect(
      (story.customFields[fields.Customers!.id] as string[]).map((id) => option('Customers', id)),
    ).toEqual(['Acme', 'Globex']);
    expect(story.customFields[fields.Budget!.id]).toBe(1200.5);
    expect(story.customFields[fields['Go-live']!.id]).toBe('2024-04-30');
    expect(story.customFields[fields.Notes!.id]).toBe('Needs legal review');
    // People fields get placeholders, like assignees.
    expect(story.customFields[fields.Reviewer!.id]).toBe(
      boot.placeholders.find((p) => p.name === 'Carol Commenter')!.id,
    );
    const [epic] = await app.db.select().from(projects).where(eq(projects.id, story.projectId!));
    expect(epic).toMatchObject({ name: 'Q1 launch', status: 'started', leadId: bobId });
    expect((await owner.get(`${ws}/issues/ENG-1`)).statusCode).toBe(404);

    const sub = await get('ENG-3');
    expect(sub.parent?.identifier).toBe('ENG-2');
    expect(sub.completedAt).toBe('2024-01-20T10:00:00.000Z');
    const crash = await get('ENG-4');
    expect(crash.canceledAt).toBe('2024-01-21T10:00:00.000Z');

    const rels = await app.db
      .select({ type: issueRelations.type, to: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(eq(issueRelations.issueId, crash.id));
    expect(rels.sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      { type: 'blocks', to: story.id },
      { type: 'duplicate', to: sub.id },
    ]);

    const thread = await app.db
      .select()
      .from(comments)
      .where(eq(comments.issueId, story.id))
      .orderBy(comments.createdAt);
    expect(thread.map((c) => c.body)).toEqual(['Looks **good**', 'Thanks', 'Shipped?']);
    expect(thread[0]!.authorId).toBe(bobId);
  });
});

describe('Jira Data Center import', () => {
  it('signs in with a personal access token, pages by offset and follows epic links', async () => {
    const res = await start({ token: PAT, projects: ['OPS'] });
    expect(res.statusCode, res.body).toBe(200);
    await settle();
    let imp = (await owner.get(`${ws}/imports/${res.data.id}`)).data as Import;
    expect(imp.summary!.counts.issues).toBe(2);
    expect(imp.summary!.projects.map((p) => [p.name, p.count])).toEqual([['Ops epic', 1]]);
    await owner.post(`${ws}/imports/${imp.id}/run`);
    await settle(16);
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
    expect(imp.status, imp.error ?? '').toBe('completed');
    expect((await get('OPS-3')).title).toBe('Ops 3');
    const linked = await get('OPS-2');
    const [epic] = await app.db.select().from(projects).where(eq(projects.id, linked.projectId!));
    expect(epic!.name).toBe('Ops epic');
    const searches = mock.log.filter((r) => r.path.startsWith('/rest/api/2/search?'));
    expect(searches.length).toBeGreaterThan(1);
    expect(searches.every((r) => r.headers.authorization === `Bearer ${PAT}`)).toBe(true);
    const [row] = await app.db.select().from(issues).where(eq(issues.title, 'Ops epic'));
    expect(row).toBeUndefined();
  });
});
