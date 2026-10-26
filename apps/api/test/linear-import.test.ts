import type { Bootstrap, Import, IssueDetail, Project } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comments, cycles, imports, issueRelations, issues } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { type ForgeRequest, startMockForge } from './mock-forge.ts';

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let ownerEmail: string;
let bobEmail: string;
let bobId: string;
const slug = `lin-${Date.now()}`;
const ws = `/api/w/${slug}`;
const KEY = 'lin_api_test_key_0123456789';

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

// ─── a small Linear ───────────────────────────────────────────────────────

const states = [
  { id: 's1', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's2', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's3', name: 'In Progress', type: 'started', position: 2 },
  { id: 's4', name: 'Done', type: 'completed', position: 3 },
  { id: 's5', name: 'Duplicate', type: 'canceled', position: 4 },
];
const linear = () => ({
  organization: { id: 'org', name: 'Acme', urlKey: 'acme' },
  teams: [
    { id: 't-eng', name: 'Engineering', key: 'ENG', issueCount: 3, states: { nodes: states } },
    { id: 't-des', name: 'Design', key: 'DES', issueCount: 1, states: { nodes: states } },
  ],
  users: [
    { id: 'u-olive', name: 'Olive Owner', displayName: 'olive', email: ownerEmail },
    { id: 'u-bob', name: 'Bob Member', displayName: 'bob', email: bobEmail },
    { id: 'u-zed', name: 'Zed Outsider', displayName: 'zed', email: 'zed@acme.test' },
    { id: 'u-unused', name: 'Never Mentioned', displayName: 'nm', email: 'nm@acme.test' },
  ],
  issueLabels: [
    { id: 'l-bug-eng', name: 'Bug', isGroup: false },
    { id: 'l-bug-des', name: 'bug', isGroup: false },
    { id: 'l-area', name: 'Area', isGroup: true },
    { id: 'l-fe', name: 'Frontend', isGroup: false },
  ],
  projects: [
    {
      id: 'p-launch',
      name: 'Launch',
      description: 'Ship it',
      state: 'started',
      startDate: '2024-01-01',
      targetDate: '2024-06-30',
      lead: { id: 'u-bob' },
      teams: { nodes: [{ id: 't-eng' }] },
    },
  ],
  cycles: [
    {
      id: 'c2',
      number: 2,
      name: null,
      startsAt: '2024-01-15T00:00:00Z',
      endsAt: '2024-01-29T00:00:00Z',
      team: { id: 't-eng' },
    },
    {
      id: 'c1',
      number: 1,
      name: 'Kickoff',
      startsAt: '2024-01-01T00:00:00Z',
      endsAt: '2024-01-15T00:00:00Z',
      team: { id: 't-eng' },
    },
  ],
  issues: [
    issue('i-1', 'ENG-1', 'Set up CI', 't-eng', 'Done', {
      assignee: { id: 'u-bob' },
      creator: { id: 'u-olive' },
      labels: { nodes: [{ id: 'l-bug-eng' }, { id: 'l-fe' }] },
      project: { id: 'p-launch' },
      cycle: { id: 'c1' },
      estimate: 2.5,
      completedAt: '2024-01-10T12:00:00.000Z',
      attachments: { nodes: [{ url: 'https://github.com/acme/app/pull/1', title: 'PR #1' }] },
    }),
    issue('i-2', 'ENG-2', 'Flaky test', 't-eng', 'In Progress', {
      assignee: { id: 'u-zed' },
      creator: { id: 'u-zed' },
      parent: { id: 'i-1' },
      cycle: { id: 'c2' },
    }),
    issue('i-3', 'ENG-3', 'Flaky test again', 't-eng', 'Todo', { creator: { id: 'u-bob' } }),
    issue('i-4', 'DES-1', 'Logo', 't-des', 'Todo', { labels: { nodes: [{ id: 'l-bug-des' }] } }),
  ],
  issueRelations: [
    { id: 'r-dup', type: 'duplicate', issue: { id: 'i-3' }, relatedIssue: { id: 'i-2' } },
    { id: 'r-block', type: 'blocks', issue: { id: 'i-1' }, relatedIssue: { id: 'i-4' } },
    { id: 'r-sim', type: 'similar', issue: { id: 'i-1' }, relatedIssue: { id: 'i-3' } },
  ],
  comments: [
    comment('k-1', 'i-2', 'u-bob', 'Seen it again', '2024-01-20T09:00:00.000Z'),
    comment('k-3', 'i-1', null, 'Deployed by the bot', '2024-01-11T09:00:00.000Z'),
    comment('k-2', 'i-2', 'u-zed', 'Fixed?', '2024-01-21T09:00:00.000Z', 'k-1'),
  ],
});

function issue(
  id: string,
  identifier: string,
  title: string,
  team: string,
  state: string,
  extra: Record<string, unknown>,
) {
  return {
    id,
    identifier,
    number: Number(identifier.split('-')[1]),
    title,
    description: `About ${title}`,
    priority: 2,
    estimate: null,
    dueDate: null,
    url: `https://linear.app/acme/issue/${identifier}`,
    createdAt: `2024-01-0${identifier.endsWith('1') ? 2 : 3}T00:00:00.000Z`,
    updatedAt: '2024-01-12T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    team: { id: team },
    state: { name: state },
    assignee: null,
    creator: null,
    project: null,
    cycle: null,
    parent: null,
    labels: { nodes: [] },
    attachments: { nodes: [] },
    ...extra,
  };
}

function comment(
  id: string,
  issueId: string,
  user: string | null,
  body: string,
  createdAt: string,
  parent?: string,
) {
  return {
    id,
    body,
    createdAt,
    user: user ? { id: user } : null,
    issue: { id: issueId },
    parent: parent ? { id: parent } : null,
  };
}

let rateLimitNext = false;

/** Answers by the field the query asks for, two items a page so paging gets exercised. */
function graphql(req: ForgeRequest) {
  const { query, variables } = req.body as { query: string; variables: { after?: string } };
  if (req.headers.authorization !== KEY) {
    return {
      status: 400,
      body: {
        errors: [
          {
            message: 'Authentication required, not authenticated',
            extensions: { code: 'AUTHENTICATION_ERROR' },
          },
        ],
      },
    };
  }
  const data = linear();
  if (query.includes('organization'))
    return { body: { data: { organization: data.organization } } };
  const field = /\{\s*(\w+)\(first/.exec(query)![1] as keyof ReturnType<typeof linear>;
  if (field === 'issues' && rateLimitNext) {
    rateLimitNext = false;
    return {
      status: 400,
      body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
    };
  }
  let nodes = data[field] as { parent?: unknown }[];
  if (query.includes('parent: { null: false }')) nodes = nodes.filter((n) => n.parent);
  const start = Number(variables.after ?? 0);
  const end = start + 2;
  return {
    body: {
      data: {
        [field]: {
          nodes: nodes.slice(start, end),
          pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
        },
      },
    },
  };
}

beforeAll(async () => {
  mock = await startMockForge();
  mock.on('POST', '/graphql', graphql);
  process.env.ORDO_LINEAR_API_URL = `${mock.url}/graphql`;
  app = await testApp({ settingsFromEnv: { allowPrivateNetworkTargets: true } });
  const o = await signup(app, 'Olive Owner');
  owner = o.client;
  ownerEmail = o.email;
  await owner.post('/api/workspaces', { name: 'Linear', slug, teamName: 'Alpha', teamKey: 'ALP' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
  const bob = await signup(app, 'Bob Member', { inviteToken: invite.token });
  bobEmail = bob.email;
  bobId = (await bob.client.get('/api/auth/me')).data.id;
});
afterAll(async () => {
  delete process.env.ORDO_LINEAR_API_URL;
  await app.close();
  await mock.close();
});

describe('Linear import', () => {
  let imp: Import;
  const issue = async (identifier: string) =>
    (await owner.get(`${ws}/issues/${identifier}`)).data as IssueDetail;

  it('checks the API key before starting', async () => {
    const bad = await owner.post(`${ws}/imports`, {
      source: 'linear',
      apiKey: 'not-the-right-key',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.data.message).toContain('Linear refused the API key');
  });

  it('analyzes the workspace', async () => {
    const res = await owner.post(`${ws}/imports`, { source: 'linear', apiKey: KEY });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.data.name).toBe('Linear: Acme');
    expect(JSON.stringify(res.data)).not.toContain(KEY);
    const [row] = await app.db.select().from(imports).where(eq(imports.id, res.data.id));
    expect(row!.secrets).not.toContain(KEY);
    // Personal API keys go as they are, without "Bearer".
    expect(mock.calls('POST', '/graphql').at(-1)!.headers.authorization).toBe(KEY);

    await settle();
    imp = (await owner.get(`${ws}/imports/${res.data.id}`)).data;
    expect(imp.status).toBe('ready');
    const s = imp.summary!;
    expect(s.teams.map((t) => t.key)).toEqual(['ENG', 'DES']);
    expect(s.counts.issues).toBe(4);
    expect(s.teams[0]!.statuses.map((x) => x.type)).toEqual([
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ]);
    // Same-named labels merge; groups aren't labels you can put on issues.
    expect(s.labels.map((l) => l.name)).toEqual(['Bug', 'Frontend']);
    expect(s.projects[0]).toMatchObject({ name: 'Launch', status: 'started', teamIds: ['t-eng'] });
    expect(s.cycles!.map((c) => c.number)).toEqual([1, 2]);
    expect(imp.mapping!.users).toMatchObject({
      'u-olive': expect.any(String),
      'u-bob': bobId,
      'u-zed': 'placeholder',
    });
  });

  it('dry-runs', async () => {
    await owner.post(`${ws}/imports/${imp.id}/dry-run`);
    await settle(8);
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
    expect(imp.report).toMatchObject({
      dryRun: true,
      created: {
        teams: 2,
        people: 1,
        labels: 2,
        projects: 1,
        cycles: 2,
        issues: 4,
        comments: 3,
        relations: 2,
      },
    });
  });

  it('waits out a rate limit, then imports everything', async () => {
    rateLimitNext = true;
    await owner.post(`${ws}/imports/${imp.id}/run`);
    await app.jobs.drain();
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
    expect(imp.status).toBe('running');
    expect(imp.error).toContain('rate limit');

    await settle(10);
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
    expect(imp.status, imp.error ?? '').toBe('completed');
    expect(imp.error).toBeNull();
    expect(imp.report!.created).toMatchObject({ issues: 4, comments: 3, relations: 2, people: 1 });

    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const eng = boot.teams.find((t) => t.key === 'ENG')!;
    const one = await issue('ENG-1');
    expect(one).toMatchObject({
      title: 'Set up CI',
      assigneeId: bobId,
      estimate: 3,
      completedAt: '2024-01-10T12:00:00.000Z',
    });
    expect(eng.states.find((s) => s.id === one.stateId)!.name).toBe('Done');
    expect(one.labelIds.map((id) => boot.labels.find((l) => l.id === id)!.name).sort()).toEqual([
      'Bug',
      'Frontend',
    ]);
    expect(one.links.map((l) => l.url).sort()).toEqual([
      'https://github.com/acme/app/pull/1',
      'https://linear.app/acme/issue/ENG-1',
    ]);
    const project = boot.projects.find((p) => p.id === one.projectId) as Project;
    expect(project).toMatchObject({
      name: 'Launch',
      status: 'started',
      leadId: bobId,
      teamIds: [eng.id],
    });
    const [kickoff] = await app.db.select().from(cycles).where(eq(cycles.id, one.cycleId!));
    expect(kickoff).toMatchObject({ name: 'Kickoff', number: 1, startsAt: '2024-01-01' });

    const two = await issue('ENG-2');
    expect(two.parent?.identifier).toBe('ENG-1');
    const zed = boot.placeholders.find((p) => p.name === 'Zed Outsider')!;
    expect(two.assigneeId).toBe(zed.id);
    expect(boot.placeholders.map((p) => p.name)).not.toContain('Never Mentioned');

    // The duplicate is linked, and keeps the status Linear gave it.
    const three = await issue('ENG-3');
    expect(eng.states.find((s) => s.id === three.stateId)!.name).toBe('Todo');
    // Other test files share the database: only this workspace's relations.
    const rels = await app.db
      .select({ type: issueRelations.type })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.issueId))
      .where(eq(issues.workspaceId, boot.workspace.id));
    expect(rels.map((r) => r.type).sort()).toEqual(['blocks', 'duplicate']);

    const thread = await app.db
      .select()
      .from(comments)
      .where(eq(comments.issueId, two.id))
      .orderBy(comments.createdAt);
    expect(thread.map((c) => c.body)).toEqual(['Seen it again', 'Fixed?']);
    expect(thread[0]!.authorId).toBe(bobId);
    expect(thread[1]!.authorId).toBe(zed.id);
    expect(thread[1]!.parentId).toBe(thread[0]!.id);
    expect(thread[0]!.createdAt).toBe('2024-01-20T09:00:00.000Z');
    const [botComment] = await app.db.select().from(comments).where(eq(comments.issueId, one.id));
    expect(botComment!.authorId).toBeNull();
    // Comments don't make imported issues look recently updated.
    const [row] = await app.db.select().from(issues).where(eq(issues.id, two.id));
    expect(row!.updatedAt).toBe('2024-01-12T00:00:00.000Z');
  });

  it('skips everything on a second run', async () => {
    await owner.post(`${ws}/imports/${imp.id}/run`);
    await settle(10);
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
    expect(imp.report).toMatchObject({
      existing: 4 + 2 + 3,
      created: { issues: 0, comments: 0, relations: 0, people: 0 },
    });
  });
});
