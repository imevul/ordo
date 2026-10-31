import { createHmac } from 'node:crypto';
import type { Bootstrap, Integration, IssueDetail } from '@ordo/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationRefs, issueLinks, issues } from '../src/db/schema.ts';
import { schedulePolls } from '../src/services/integrations.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { type ForgeRequest, startMockForge } from './mock-forge.ts';

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let bobId: string;
let bobEmail: string;
let boot: Bootstrap;
const slug = `jira-${Date.now()}`;
const ws = `/api/w/${slug}`;
const alpha = () => boot.teams.find((t) => t.key === 'ALP')!;
const stateName = (id: string) => alpha().states.find((s) => s.id === id)?.name;
const stateId = (name: string) => alpha().states.find((s) => s.name === name)!.id;

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

// ─── a tiny Jira ──────────────────────────────────────────────────────────

const STATUSES = {
  'To Do': { name: 'To Do', statusCategory: { key: 'new' } },
  'In Progress': { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
  Done: { name: 'Done', statusCategory: { key: 'done' } },
} as const;
type StatusName = keyof typeof STATUSES;
/** The account of Ordo's token, and someone working in Jira. */
const BOT = { accountId: 'acc-bot', displayName: 'Ordo Bot' };
const CARA = { accountId: 'acc-cara', displayName: 'Cara Customer' };

interface FakeIssue {
  id: string;
  key: string;
  summary: string;
  description: string | null;
  status: StatusName;
  priority: string | null;
  assignee: { accountId: string; displayName: string; emailAddress?: string } | null;
  creator: { accountId: string; displayName: string };
  updated: string;
  comments: {
    id: string;
    body: string;
    created: string;
    author: { accountId: string; displayName: string; emailAddress?: string };
  }[];
}

const jiraIssues = new Map<string, FakeIssue>();
let nextId = 10_000;
const touch = (i: FakeIssue) => {
  i.updated = new Date(Date.now() + nextId++).toISOString().replace('Z', '+0000');
};
const find = (idOrKey: string) =>
  jiraIssues.get(idOrKey) ?? [...jiraIssues.values()].find((i) => i.key === idOrKey);
function addJira(key: string, extra: Partial<FakeIssue> = {}) {
  const issue: FakeIssue = {
    id: String(nextId++),
    key,
    summary: `Jira ${key}`,
    description: null,
    status: 'To Do',
    priority: 'Medium',
    assignee: null,
    creator: CARA,
    updated: '',
    comments: [],
    ...extra,
  };
  touch(issue);
  jiraIssues.set(issue.id, issue);
  return issue;
}
const asJson = (i: FakeIssue) => ({
  id: i.id,
  key: i.key,
  fields: {
    summary: i.summary,
    description: i.description,
    status: STATUSES[i.status],
    priority: i.priority ? { name: i.priority } : null,
    assignee: i.assignee,
    creator: i.creator,
    issuetype: { name: 'Task' },
    parent: null,
    updated: i.updated,
  },
});
/** Runs while Jira is still answering Ordo's create call. */
let whileCreating: ((created: FakeIssue) => Promise<void>) | null = null;
/** Runs once, after the next issue PUT is applied and before Jira answers it. */
let whilePut: ((issue: FakeIssue) => Promise<void>) | null = null;

async function jiraApi(req: ForgeRequest) {
  const url = new URL(req.path, 'http://x');
  const parts = url.pathname.replace('/rest/api/2/issue', '').split('/').filter(Boolean);
  // What Ordo sends: the subset of Jira's request bodies it uses.
  const body = req.body as {
    fields: {
      project: { key: string };
      summary?: string;
      description?: string | null;
      priority?: { name: string };
      assignee?: { accountId: string } | null;
    };
    transition: { id: string };
    body: string;
  } | null;
  if (req.method === 'POST' && parts.length === 0) {
    const project = body!.fields.project.key;
    const n = [...jiraIssues.values()].filter((i) => i.key.startsWith(`${project}-`)).length + 1;
    const created = addJira(`${project}-${n}`, {
      summary: body!.fields.summary!,
      description: body!.fields.description ?? null,
      creator: BOT,
    });
    await whileCreating?.(created);
    return { status: 201, body: { id: created.id, key: created.key } };
  }
  const issue = find(decodeURIComponent(parts[0] ?? ''));
  if (!issue) return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
  const sub = parts[1];
  if (!sub && req.method === 'GET') return { body: asJson(issue) };
  if (!sub && req.method === 'PUT') {
    const f = body!.fields;
    if (f.summary !== undefined) issue.summary = f.summary;
    if (f.description !== undefined) issue.description = f.description;
    if (f.priority) issue.priority = f.priority.name;
    if (f.assignee !== undefined)
      issue.assignee = f.assignee && { accountId: f.assignee.accountId, displayName: 'Bob Member' };
    touch(issue);
    const fn = whilePut;
    whilePut = null;
    await fn?.(issue);
    return { status: 204, body: null };
  }
  if (sub === 'transitions' && req.method === 'GET') {
    return {
      body: {
        transitions: Object.values(STATUSES).map((s, n) => ({ id: String(n + 1), to: s })),
      },
    };
  }
  if (sub === 'transitions' && req.method === 'POST') {
    issue.status = Object.keys(STATUSES)[Number(body!.transition.id) - 1] as StatusName;
    touch(issue);
    return { status: 204, body: null };
  }
  if (sub === 'comment' && req.method === 'GET') return { body: { comments: issue.comments } };
  if (sub === 'comment' && req.method === 'POST') {
    const c = { id: String(nextId++), body: body!.body, created: issue.updated, author: BOT };
    issue.comments.push(c);
    touch(issue);
    return { status: 201, body: c };
  }
  if (sub === 'remotelink') return { status: 201, body: { id: 1 } };
  return { status: 404, body: {} };
}

const calls = (method: string, pathPart: string) =>
  mock.log.filter((r) => r.method === method && r.path.includes(pathPart));

beforeAll(async () => {
  mock = await startMockForge();
  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  owner = (await signup(app, 'Jo Owner')).client;
  await owner.post('/api/workspaces', { name: 'Jira', slug, teamName: 'Alpha', teamKey: 'ALP' });
  await owner.post(`${ws}/teams`, { name: 'Ops', key: 'OPS' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
  const bob = await signup(app, 'Bob Member', { inviteToken: invite.token });
  bobEmail = bob.email;
  bobId = (await bob.client.get('/api/auth/me')).data.id;
  // Bob works in Alpha, so issues can be assigned to him there.
  const teamId = (await owner.get(`${ws}/bootstrap`)).data.teams.find(
    (t: { key: string }) => t.key === 'ALP',
  ).id;
  expect((await owner.post(`${ws}/teams/${teamId}/members`, { userId: bobId })).statusCode).toBe(
    200,
  );
  boot = (await owner.get(`${ws}/bootstrap`)).data;

  mock.on('GET', '/rest/api/2/myself', BOT);
  mock.on('GET', '/rest/api/2/project', [{ key: 'JRA' }, { key: 'OPS' }]);
  mock.on('GET', '/rest/api/2/priority', [
    { name: 'Highest' },
    { name: 'High' },
    { name: 'Medium' },
    { name: 'Low' },
  ]);
  mock.on('GET', '/rest/api/2/user/search', () => ({
    body: [{ accountId: 'acc-bob', displayName: 'Bob Member', emailAddress: bobEmail }],
  }));
  mock.on('GET', '/rest/api/2/search/jql', () => ({
    body: { issues: [...jiraIssues.values()].map(asJson), isLast: true },
  }));
  for (const method of ['GET', 'POST', 'PUT']) mock.onPrefix(method, '/rest/api/2/issue', jiraApi);
});
afterAll(async () => {
  await app.close();
  await mock.close();
});

const connect = async (config: Record<string, unknown>, secrets: Record<string, unknown> = {}) => {
  const res = await owner.post(`${ws}/integrations`, {
    provider: 'jira',
    config: { siteUrl: mock.url, ...config },
    secrets: { token: 'jira-token', email: 'bot@example.com', ...secrets },
  });
  return res;
};
const hook = (i: Integration, body: object, secret?: string) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: i.inboundUrl!.slice(app.env.publicUrl.length),
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-atlassian-webhook-identifier': `${Math.random()}`,
      ...(secret && {
        'x-hub-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      }),
    },
  });
};
const updated = (i: FakeIssue) => ({
  webhookEvent: 'jira:issue_updated',
  issue: { id: i.id, key: i.key },
});
const detail = async (idOrIdentifier: string) =>
  (await owner.get(`${ws}/issues/${idOrIdentifier}`)).data as IssueDetail;
const newIssue = async (title: string, extra: Record<string, unknown> = {}) =>
  (await owner.post(`${ws}/issues`, { teamId: alpha().id, title, ...extra })).data as {
    id: string;
    identifier: string;
  };

// ─── links ────────────────────────────────────────────────────────────────

describe('links mode', () => {
  let links: Integration;

  it('checks the settings', async () => {
    expect((await connect({ mode: 'links' }, { token: '' })).statusCode).toBe(400);
    expect((await connect({ mode: 'mirror', projects: [{ key: 'JRA' }] })).statusCode).toBe(400);
    const res = await connect({ mode: 'links' }, { webhookSecret: 'shh' });
    expect(res.statusCode).toBe(200);
    links = res.data;
    expect(links.status).toBe('active');
    expect(links.inboundUrl).toContain('/api/hooks/jira/');
  });

  it('links Jira keys and URLs mentioned in Ordo, with their status, and links back', async () => {
    const one = addJira('JRA-1', { summary: 'Login breaks' });
    addJira('OPS-1');
    const issue = await newIssue('Fix login', {
      description: `Reported as JRA-1, see also ${mock.url}/browse/JRA-1. OPS-1 is ours.`,
    });
    await settle();
    const d = await detail(issue.id);
    const jiraLinks = d.links.filter((l) => l.kind === 'external_issue');
    expect(jiraLinks).toHaveLength(1); // OPS-1 is an Ordo team key, so it isn't Jira's
    expect(jiraLinks[0]).toMatchObject({ title: 'JRA-1 Login breaks', state: 'To Do' });
    expect(calls('POST', '/rest/api/2/issue/JRA-1/remotelink')).toHaveLength(1);

    // A webhook refreshes the status; unsigned deliveries are refused once a secret is set.
    one.status = 'Done';
    touch(one);
    expect((await hook(links, updated(one))).statusCode).toBe(401);
    expect((await hook(links, updated(one), 'not-the-secret')).statusCode).toBe(401);
    await settle();
    expect((await detail(issue.id)).links.find((l) => l.kind === 'external_issue')?.state).toBe(
      'To Do',
    );
    expect((await hook(links, updated(one), 'shh')).statusCode).toBe(202);
    await settle();
    expect((await detail(issue.id)).links.find((l) => l.kind === 'external_issue')?.state).toBe(
      'Done',
    );
  });

  it('links Ordo issues mentioned in Jira', async () => {
    const issue = await newIssue('Mentioned from Jira');
    const j = addJira('JRA-50', {
      description: `Tracked in ${app.env.publicUrl}/${slug}/issue/${issue.identifier}`,
    });
    await hook(links, updated(j), 'shh');
    await settle();
    expect((await detail(issue.id)).links.map((l) => l.title)).toContain(`JRA-50 ${j.summary}`);
    await owner.del(`${ws}/integrations/${links.id}`);
  });
});

// ─── mirror and sync ──────────────────────────────────────────────────────

describe('mirror and sync', () => {
  let jira: Integration;
  const putsTo = (key: string) => calls('PUT', `/rest/api/2/issue/${key}`).length;

  it('mirrors new Jira issues into the mapped team', async () => {
    const res = await connect({
      mode: 'mirror',
      projects: [{ key: 'JRA', teamId: alpha().id, createInOrdo: true }],
    });
    expect(res.statusCode).toBe(200);
    jira = res.data;
    const j = addJira('JRA-2', {
      summary: 'Checkout is slow',
      description: 'It *really* is.',
      status: 'In Progress',
      priority: 'Highest',
      assignee: { accountId: 'acc-bob', displayName: 'Bob Member', emailAddress: bobEmail },
    });
    await hook(jira, updated(j));
    await settle();
    const [ref] = await app.db
      .select()
      .from(integrationRefs)
      .where(and(eq(integrationRefs.integrationId, jira.id), eq(integrationRefs.externalId, j.id)));
    const d = await detail(ref!.localId);
    expect(d).toMatchObject({
      title: 'Checkout is slow',
      description: 'It **really** is.',
      priority: 1,
      assigneeId: bobId,
    });
    expect(stateName(d.stateId)).toBe('In Progress');
    expect(d.links.find((l) => l.kind === 'external_issue')?.title).toBe('JRA-2 Checkout is slow');

    // Jira changes follow; Ordo changes stay in Ordo.
    j.summary = 'Checkout is very slow';
    j.comments.push({
      id: 'c1',
      body: 'Seen on mobile too',
      created: new Date(Date.now() + 60_000).toISOString(),
      author: { accountId: 'acc-cara', displayName: 'Cara Customer' },
    });
    touch(j);
    await hook(jira, updated(j));
    await settle();
    const after = await detail(ref!.localId);
    expect(after.title).toBe('Checkout is very slow');
    const comments = (await owner.get(`${ws}/issues/${ref!.localId}/comments`)).data as {
      body: string;
    }[];
    expect(comments.map((c) => c.body)).toContainEqual(
      expect.stringContaining('Seen on mobile too'),
    );
    await owner.patch(`${ws}/issues/${ref!.localId}`, { title: 'Local title' });
    await settle();
    expect(putsTo('JRA-2')).toBe(0);
  });

  it('adopts issues the Jira importer brought in instead of duplicating them', async () => {
    const imported = await newIssue('Imported earlier');
    await app.db.insert(issueLinks).values({
      workspaceId: boot.workspace.id,
      issueId: imported.id,
      provider: 'jira',
      kind: 'link',
      externalId: 'JRA-3',
      url: `${mock.url}/browse/JRA-3`,
      title: 'JRA-3 (imported)',
    });
    const j = addJira('JRA-3', { summary: 'Imported, renamed in Jira' });
    await hook(jira, updated(j));
    await settle();
    expect((await detail(imported.id)).title).toBe('Imported, renamed in Jira');
    const refs = await app.db
      .select()
      .from(integrationRefs)
      .where(
        and(
          eq(integrationRefs.integrationId, jira.id),
          eq(integrationRefs.kind, 'issue'),
          eq(integrationRefs.externalId, j.id),
        ),
      );
    expect(refs.map((r) => r.localId)).toEqual([imported.id]);
  });

  it('in sync mode, sends Ordo changes to Jira without echoing them back', async () => {
    const res = await owner.patch(`${ws}/integrations/${jira.id}`, {
      config: {
        mode: 'sync',
        projects: [{ key: 'JRA', teamId: alpha().id, createInOrdo: true, createInJira: true }],
      },
    });
    expect(res.data.status).toBe('active');
    const j = find('JRA-3')!;
    const [ref] = await app.db
      .select()
      .from(integrationRefs)
      .where(eq(integrationRefs.externalId, j.id));
    await owner.patch(`${ws}/issues/${ref!.localId}`, {
      title: 'Renamed in Ordo',
      description: 'Now **bold**',
      stateId: stateId('Done'),
      priority: 2,
      assigneeId: bobId,
    });
    await settle();
    expect(j).toMatchObject({
      summary: 'Renamed in Ordo',
      description: 'Now *bold*',
      status: 'Done',
      priority: 'High',
    });
    expect(j.assignee?.accountId).toBe('acc-bob');

    // Jira's webhook for that change finds nothing new: no write comes back.
    const puts = putsTo('JRA-3');
    const before = await detail(ref!.localId);
    await hook(jira, updated(j));
    await settle();
    const after = await detail(ref!.localId);
    expect(after.description).toBe('Now **bold**');
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(putsTo('JRA-3')).toBe(puts);

    // Comments go over with their author's name, and don't come back as new Ordo comments.
    await owner.post(`${ws}/issues/${ref!.localId}/comments`, { body: 'Shipped `v2`' });
    await settle();
    expect(j.comments.at(-1)?.body).toBe('*Jo Owner* in Ordo:\n\nShipped {{v2}}');
    await hook(jira, updated(j));
    await settle();
    const comments = (await owner.get(`${ws}/issues/${ref!.localId}/comments`)).data as unknown[];
    expect(comments).toHaveLength(1);
  });

  it("doesn't take its own push for a Jira change while the push is still running", async () => {
    // Jira's webhook for Ordo's first PUT arrives before the push saved its new snapshot, and the
    // user edits the issue again meanwhile. The newer edit must win on both sides.
    const j = find('JRA-3')!;
    const [ref] = await app.db
      .select()
      .from(integrationRefs)
      .where(eq(integrationRefs.externalId, j.id));
    whilePut = async (i) => {
      await owner.patch(`${ws}/issues/${ref!.localId}`, { title: 'Third' });
      expect((await hook(jira, updated(i))).statusCode).toBe(202);
      await app.jobs.drain();
    };
    await owner.patch(`${ws}/issues/${ref!.localId}`, { title: 'Second' });
    await settle();
    expect(whilePut).toBeNull();
    expect({ ordo: (await detail(ref!.localId)).title, jira: j.summary }).toEqual({
      ordo: 'Third',
      jira: 'Third',
    });
  });

  it("doesn't mirror back a Jira issue it's still creating", async () => {
    // Inbound work doesn't wait for outbound work, so Jira's webhook for an issue Ordo creates
    // can be handled before Ordo has recorded the issue as its own.
    whileCreating = async (created) => {
      expect(
        (await hook(jira, { webhookEvent: 'jira:issue_created', issue: { id: created.id } }))
          .statusCode,
      ).toBe(202);
      await app.jobs.drain();
    };
    try {
      const issue = await newIssue('Created mid-webhook');
      await settle();
      const created = [...jiraIssues.values()].find((i) => i.summary === 'Created mid-webhook')!;
      expect(calls('GET', `/rest/api/2/issue/${created.id}`).length).toBeGreaterThan(0);
      const same = await app.db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(eq(issues.workspaceId, boot.workspace.id), eq(issues.title, 'Created mid-webhook')),
        );
      expect(same.map((r) => r.id)).toEqual([issue.id]);
      const refs = await app.db
        .select({ localId: integrationRefs.localId })
        .from(integrationRefs)
        .where(eq(integrationRefs.externalId, created.id));
      expect(refs).toEqual([{ localId: issue.id }]);
    } finally {
      whileCreating = null;
    }
  });

  it('creates Jira issues for new issues in mapped teams', async () => {
    const issue = await newIssue('Born in Ordo', { description: 'From *Ordo*' });
    await settle();
    const created = [...jiraIssues.values()].find((i) => i.summary === 'Born in Ordo')!;
    expect(created.description).toBe('From _Ordo_');
    const d = await detail(issue.id);
    expect(d.links.find((l) => l.kind === 'external_issue')?.title).toBe(
      `${created.key} Born in Ordo`,
    );
    // The Jira issue showing up in a later poll is recognised, not mirrored again.
    await owner.patch(`${ws}/integrations/${jira.id}`, { config: { delivery: 'poll' } });
    await schedulePolls(app);
    await settle();
    const same = await app.db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.workspaceId, boot.workspace.id), eq(issues.title, 'Born in Ordo')));
    expect(same).toHaveLength(1);
    expect(calls('GET', '/rest/api/2/search/jql').length).toBeGreaterThan(0);
  });
});
