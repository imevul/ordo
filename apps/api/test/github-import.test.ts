import type { Bootstrap, Import, IssueDetail } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comments, externalAccounts, imports, projects } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { type ForgeRequest, startMockForge } from './mock-forge.ts';

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let bobId: string;
let boot: Bootstrap;
const slug = `gh-${Date.now()}`;
const ws = `/api/w/${slug}`;
const TOKEN = 'ghp_test_token_0123456789';

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

// ─── a small GitHub ───────────────────────────────────────────────────────

const issue = (
  number: number,
  title: string,
  extra: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  number,
  title,
  body: `About ${title}`,
  state: 'open',
  state_reason: null,
  user: { login: 'octo-olive' },
  assignee: null,
  labels: [],
  milestone: null,
  comments: 0,
  created_at: `2024-02-0${number}T10:00:00Z`,
  updated_at: '2024-02-20T10:00:00Z',
  closed_at: null,
  html_url: `https://github.com/acme/app/issues/${number}`,
  ...extra,
});

const repos: Record<string, Record<string, unknown[]>> = {
  'acme/app': {
    labels: [{ name: 'bug' }, { name: 'ui' }],
    milestones: [
      {
        number: 1,
        title: 'v1.0',
        description: 'First',
        state: 'open',
        due_on: '2024-05-01T07:00:00Z',
      },
    ],
    issues: [
      issue(1, 'Crash on start', {
        assignee: { login: 'octo-bob' },
        labels: [{ name: 'bug' }, 'ui'],
        milestone: { number: 1 },
        comments: 1,
      }),
      issue(2, 'Fix the crash', { pull_request: { url: 'x' } }),
      issue(3, 'Docs', {
        user: { login: 'octo-bob' },
        state: 'closed',
        state_reason: 'completed',
        closed_at: '2024-02-10T10:00:00Z',
        comments: 1,
      }),
      issue(4, 'Rewrite in Rust', {
        user: { login: 'stranger' },
        state: 'closed',
        state_reason: 'not_planned',
        closed_at: '2024-02-11T10:00:00Z',
      }),
    ],
    comments: [
      comment(11, 1, 'carol', 'Me too', '2024-02-02T10:00:00Z'),
      comment(12, 2, 'octo-bob', 'On the pull request', '2024-02-03T10:00:00Z'),
      comment(13, 3, 'octo-bob', 'Written', '2024-02-09T10:00:00Z'),
    ],
  },
  'acme/site': {
    labels: [{ name: 'Bug' }],
    milestones: [],
    issues: [issue(1, 'Landing page', { labels: [{ name: 'Bug' }] })],
    comments: [],
  },
};

function comment(id: number, n: number, user: string, body: string, created: string) {
  return {
    id,
    body,
    created_at: created,
    user: { login: user },
    issue_url: `https://api.github.com/repos/acme/app/issues/${n}`,
  };
}

/** Repositories, two items a page with a Link header, the way GitHub pages. */
function github(req: ForgeRequest) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return { status: 401, body: { message: 'Bad credentials' } };
  }
  const url = new URL(req.path, 'http://x');
  const m = /^\/repos\/([\w.-]+\/[\w.-]+)(?:\/(issues\/comments|issues|labels|milestones))?$/.exec(
    url.pathname,
  );
  const repo = m && repos[m[1]!];
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  if (!m![2]) return { body: { full_name: m![1] } };
  const list = repo[m![2] === 'issues/comments' ? 'comments' : m![2]!]!;
  const page = Number(url.searchParams.get('page') ?? 1);
  const more = page * 2 < list.length;
  return {
    body: list.slice((page - 1) * 2, page * 2),
    headers: more ? { link: `<${mock.url}${url.pathname}?page=${page + 1}>; rel="next"` } : {},
  };
}

beforeAll(async () => {
  mock = await startMockForge();
  mock.onPrefix('GET', '/repos/', github);
  app = await testApp({ settingsFromEnv: { allowPrivateNetworkTargets: true } });
  owner = (await signup(app, 'Olive Owner')).client;
  await owner.post('/api/workspaces', { name: 'GitHub', slug, teamName: 'Alpha', teamKey: 'ALP' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
  const bob = await signup(app, 'Bob Member', { inviteToken: invite.token });
  bobId = (await bob.client.get('/api/auth/me')).data.id;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  // Bob claimed his GitHub username (on this "GitHub", the mock's host).
  await app.db.insert(externalAccounts).values({
    workspaceId: boot.workspace.id,
    userId: bobId,
    provider: 'github',
    host: new URL(mock.url).host,
    externalId: 'octo-bob',
    username: 'octo-bob',
  });
});
afterAll(async () => {
  await app.close();
  await mock.close();
});

describe('GitHub Issues import', () => {
  let imp: Import;
  const start = (body: Record<string, unknown>) =>
    owner.post(`${ws}/imports`, { source: 'github', token: TOKEN, apiUrl: mock.url, ...body });

  it('checks the token and the repositories', async () => {
    const bad = await start({ token: 'ghp_wrong_token_000', repos: ['acme/app'] });
    expect(bad.data.message).toContain('GitHub refused the token');
    const missing = await start({ repos: ['acme/app', 'acme/secret'] });
    expect(missing.statusCode).toBe(400);
    expect(missing.data.message).toBe("Can't see acme/secret with this token");
    const malformed = await start({ repos: ['not a repo'] });
    expect(malformed.statusCode).toBe(400);
  });

  it('analyzes the repositories', async () => {
    const res = await start({ repos: ['acme/app', 'acme/site'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.data.name).toBe('GitHub: acme/app and 1 more');
    const [row] = await app.db.select().from(imports).where(eq(imports.id, res.data.id));
    expect(row!.secrets).not.toContain(TOKEN);
    await settle();
    imp = (await owner.get(`${ws}/imports/${res.data.id}`)).data;
    expect(imp.status, imp.error ?? '').toBe('ready');
    const s = imp.summary!;
    // Pull requests aren't issues.
    expect(s.counts).toEqual({ issues: 4, comments: 2 });
    expect(s.teams.map((t) => [t.id, t.name, t.issueCount])).toEqual([
      ['acme/app', 'app', 3],
      ['acme/site', 'site', 1],
    ]);
    expect(s.teams[0]!.statuses).toEqual(
      expect.arrayContaining([
        { name: 'Open', type: 'unstarted', count: 1 },
        { name: 'Closed', type: 'completed', count: 1 },
        { name: 'Closed as not planned', type: 'canceled', count: 1 },
      ]),
    );
    expect(s.labels.map((l) => [l.name, l.count])).toEqual([
      ['bug', 2],
      ['ui', 1],
    ]);
    expect(s.projects[0]).toMatchObject({ name: 'v1.0', targetDate: '2024-05-01', count: 1 });
    // A commenter who never opened or took an issue is still someone to map.
    expect(s.users.map((u) => u.id).sort()).toEqual([
      'carol',
      'octo-bob',
      'octo-olive',
      'stranger',
    ]);
    // Bob is found by the GitHub username he claimed.
    expect(imp.mapping!.users['octo-bob']).toBe(bobId);
    expect(imp.mapping!.users.carol).toBe('placeholder');
    expect(imp.mapping!.teams['acme/app']).toEqual({ create: { name: 'app', key: 'APP' } });
  });

  it('imports issues, milestones and comments', async () => {
    await owner.post(`${ws}/imports/${imp.id}/run`);
    await settle(12);
    imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
    expect(imp.status, imp.error ?? '').toBe('completed');
    expect(imp.report!.created).toMatchObject({
      teams: 2,
      labels: 2,
      projects: 1,
      issues: 4,
      comments: 2,
    });

    const get = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as IssueDetail;
    boot = (await owner.get(`${ws}/bootstrap`)).data;
    const app1 = await get('APP-1');
    expect(app1).toMatchObject({ title: 'Crash on start', assigneeId: bobId });
    expect(app1.links.map((l) => l.url)).toEqual(['https://github.com/acme/app/issues/1']);
    const [milestone] = await app.db
      .select()
      .from(projects)
      .where(eq(projects.id, app1.projectId!));
    expect(milestone).toMatchObject({ name: 'v1.0', status: 'planned', targetDate: '2024-05-01' });

    // Numbers stay, gaps where pull requests were included.
    const app3 = await get('APP-3');
    expect(app3.creatorId).toBe(bobId);
    expect(app3.completedAt).toBe('2024-02-10T10:00:00.000Z');
    const app4 = await get('APP-4');
    expect(app4.canceledAt).toBe('2024-02-11T10:00:00.000Z');
    expect((await owner.get(`${ws}/issues/APP-2`)).statusCode).toBe(404);

    const site = await get('SITE-1');
    expect(site.labelIds).toEqual([boot.labels.find((l) => l.name === 'bug')!.id]);

    const thread = await app.db.select().from(comments).where(eq(comments.issueId, app1.id));
    const carol = boot.placeholders.find((p) => p.name === 'carol')!;
    expect(thread.map((c) => [c.body, c.authorId])).toEqual([['Me too', carol.id]]);
  });
});
