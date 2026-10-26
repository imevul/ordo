import type { Bootstrap, Import, IssueDetail } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comments, projects } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { type ForgeRequest, startMockForge } from './mock-forge.ts';

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let bobEmail: string;
let bobId: string;
const slug = `forges-${Date.now()}`;
const ws = `/api/w/${slug}`;
const TOKEN = 'forge_token_0123456789';

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

/** Two items a page, with a Link header to the next one. */
function paged(req: ForgeRequest, list: unknown[]) {
  const url = new URL(req.path, 'http://x');
  const page = Number(url.searchParams.get('page') ?? 1);
  const more = page * 2 < list.length;
  return {
    body: list.slice((page - 1) * 2, page * 2),
    headers: more ? { link: `<${mock.url}${url.pathname}?page=${page + 1}>; rel="next"` } : {},
  };
}

const get = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as IssueDetail;

async function importFrom(body: Record<string, unknown>) {
  const res = await owner.post(`${ws}/imports`, { token: TOKEN, ...body });
  expect(res.statusCode, res.body).toBe(200);
  await settle();
  let imp = (await owner.get(`${ws}/imports/${res.data.id}`)).data as Import;
  expect(imp.status, imp.error ?? '').toBe('ready');
  const analyzed = imp;
  await owner.post(`${ws}/imports/${imp.id}/run`);
  await settle(16);
  imp = (await owner.get(`${ws}/imports/${imp.id}`)).data;
  expect(imp.status, imp.error ?? '').toBe('completed');
  return { analyzed, imp };
}

// ─── Forgejo / Gitea ──────────────────────────────────────────────────────

function forgejo(req: ForgeRequest) {
  if (req.headers.authorization !== `token ${TOKEN}`) {
    return { status: 401, body: { message: 'token is required' } };
  }
  const path = new URL(req.path, 'http://x').pathname.replace('/api/v1/repos/acme/tools', '');
  const issue = (n: number, title: string, extra: Record<string, unknown> = {}) => ({
    number: n,
    title,
    body: '',
    state: 'open',
    user: { login: 'dev-dana', email: 'dana@users.noreply.codeberg.test' },
    assignee: null,
    labels: [],
    milestone: null,
    comments: 0,
    created_at: `2024-03-0${n}T08:00:00Z`,
    updated_at: '2024-03-20T08:00:00Z',
    closed_at: null,
    html_url: `https://codeberg.test/acme/tools/issues/${n}`,
    pull_request: null,
    ...extra,
  });
  if (path === '') return { body: { full_name: 'acme/tools' } };
  if (path === '/labels') return paged(req, [{ name: 'ci' }]);
  if (path === '/milestones') {
    return paged(req, [
      { id: 7, title: 'Spring', description: null, state: 'open', due_on: '2024-04-30T00:00:00Z' },
    ]);
  }
  if (path === '/issues') {
    return paged(req, [
      issue(1, 'Broken build', {
        assignee: { login: 'dev-bob' },
        labels: [{ name: 'ci' }],
        milestone: { id: 7 },
        comments: 1,
      }),
      issue(2, 'Old idea', { state: 'closed', closed_at: '2024-03-15T08:00:00Z' }),
      issue(3, 'Faster tests', { user: { login: 'dev-bob', email: bobEmail } }),
    ]);
  }
  if (path === '/issues/comments') {
    return paged(req, [
      {
        id: 31,
        body: 'Seen it',
        created_at: '2024-03-02T09:00:00Z',
        user: { login: 'erin' },
        issue_url: 'https://codeberg.test/acme/tools/issues/1',
      },
    ]);
  }
  return { status: 404, body: { message: 'not found' } };
}

// ─── GitLab ───────────────────────────────────────────────────────────────

function gitlab(req: ForgeRequest) {
  if (req.headers['private-token'] !== TOKEN)
    return { status: 401, body: { message: '401 Unauthorized' } };
  const url = new URL(req.path, 'http://x');
  const path = url.pathname.replace('/api/v4', '');
  if (path === `/projects/${encodeURIComponent('grp/sub/web')}`) {
    return { body: { id: 42, path_with_namespace: 'grp/sub/web', name: 'Web' } };
  }
  const user = (username: string, name: string) => ({ username, name });
  const v2 = {
    id: 900,
    title: 'v2',
    description: 'Second',
    state: 'active',
    due_date: '2024-07-01',
  };
  const issue = (iid: number, title: string, extra: Record<string, unknown> = {}) => ({
    iid,
    title,
    description: null,
    state: 'opened',
    author: user('gl-gary', 'Gary Gitlab'),
    assignee: null,
    labels: [],
    milestone: null,
    user_notes_count: 0,
    created_at: `2024-05-0${iid}T08:00:00.000Z`,
    updated_at: '2024-05-20T08:00:00.000Z',
    closed_at: null,
    due_date: null,
    weight: null,
    web_url: `https://gitlab.test/grp/sub/web/-/issues/${iid}`,
    ...extra,
  });
  if (path === '/projects/42/labels') return paged(req, [{ name: 'backend' }]);
  if (path === '/projects/42/milestones') return paged(req, [v2]);
  if (path === '/projects/42/issues') {
    return paged(req, [
      issue(1, 'Slow API', {
        assignee: user('gl-bob', 'Bob Member'),
        labels: ['backend'],
        milestone: v2,
        user_notes_count: 1,
        weight: 3,
        due_date: '2024-06-15',
      }),
      issue(2, 'Group work', {
        state: 'closed',
        closed_at: '2024-05-10T08:00:00.000Z',
        milestone: { id: 950, title: 'Q3 (group)', state: 'active', due_date: null },
      }),
      issue(3, 'Docs'),
    ]);
  }
  if (path === '/projects/42/issues/1/notes') {
    return paged(req, [
      {
        id: 1,
        body: 'added ~backend label',
        created_at: '2024-05-01T09:00:00.000Z',
        author: user('gl-gary', 'Gary Gitlab'),
        system: true,
      },
      {
        id: 2,
        body: 'On it',
        created_at: '2024-05-02T09:00:00.000Z',
        author: user('gl-hana', 'Hana'),
        system: false,
      },
    ]);
  }
  return { status: 404, body: { message: '404 Not Found' } };
}

beforeAll(async () => {
  mock = await startMockForge();
  mock.onPrefix('GET', '/api/v1/', forgejo);
  mock.onPrefix('GET', '/api/v4/', gitlab);
  app = await testApp({ settingsFromEnv: { allowPrivateNetworkTargets: true } });
  owner = (await signup(app, 'Olive Owner')).client;
  await owner.post('/api/workspaces', { name: 'Forges', slug, teamName: 'Alpha', teamKey: 'ALP' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
  const bob = await signup(app, 'Bob Member', { inviteToken: invite.token });
  bobEmail = bob.email;
  bobId = (await bob.client.get('/api/auth/me')).data.id;
});
afterAll(async () => {
  await app.close();
  await mock.close();
});

describe('Forgejo/Gitea import', () => {
  it('checks the token and repositories', async () => {
    const bad = await owner.post(`${ws}/imports`, {
      source: 'forgejo',
      baseUrl: mock.url,
      token: 'not_the_token_123',
      repos: ['acme/tools'],
    });
    expect(bad.data.message).toContain('Forgejo refused the token');
    const missing = await owner.post(`${ws}/imports`, {
      source: 'forgejo',
      baseUrl: mock.url,
      token: TOKEN,
      repos: ['acme/gone'],
    });
    expect(missing.data.message).toBe("Can't see acme/gone with this token");
  });

  it('imports issues, milestones and comments', async () => {
    const { analyzed, imp } = await importFrom({
      source: 'forgejo',
      baseUrl: mock.url,
      repos: ['acme/tools'],
    });
    const s = analyzed.summary!;
    expect(s.counts).toEqual({ issues: 3, comments: 1 });
    expect(s.teams[0]).toMatchObject({ id: 'acme/tools', name: 'tools', issueCount: 3 });
    // No-reply addresses aren't anyone's email; Bob's real one finds him.
    expect(s.users.find((u) => u.id === 'dev-dana')!.email).toBeNull();
    expect(analyzed.mapping!.users['dev-bob']).toBe(bobId);
    expect(analyzed.mapping!.users.erin).toBe('placeholder');
    expect(imp.report!.created).toMatchObject({ teams: 1, projects: 1, issues: 3, comments: 1 });

    const build = await get('TOOLS-1');
    expect(build.assigneeId).toBe(bobId);
    const [spring] = await app.db.select().from(projects).where(eq(projects.id, build.projectId!));
    expect(spring).toMatchObject({ name: 'Spring', targetDate: '2024-04-30' });
    expect((await get('TOOLS-2')).completedAt).toBe('2024-03-15T08:00:00.000Z');
    const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
    const [seen] = await app.db.select().from(comments).where(eq(comments.issueId, build.id));
    expect(seen!.authorId).toBe(boot.placeholders.find((p) => p.name === 'erin')!.id);
  });
});

describe('GitLab import', () => {
  it('imports issues with weights, milestones (group ones too) and notes', async () => {
    const missing = await owner.post(`${ws}/imports`, {
      source: 'gitlab',
      baseUrl: mock.url,
      token: TOKEN,
      projects: ['grp/gone'],
    });
    expect(missing.data.message).toBe("Can't see grp/gone with this token");

    const { analyzed, imp } = await importFrom({
      source: 'gitlab',
      baseUrl: mock.url,
      projects: ['grp/sub/web'],
    });
    const s = analyzed.summary!;
    expect(analyzed.name).toBe('GitLab: grp/sub/web');
    // System notes ("added ~backend label") aren't comments.
    expect(s.counts).toEqual({ issues: 3, comments: 1 });
    expect(s.teams[0]).toMatchObject({ id: 'grp/sub/web', name: 'Web' });
    expect(s.projects.map((p) => p.name).sort()).toEqual(['Q3 (group)', 'v2']);
    // GitLab gives names, so Bob is found by his.
    expect(analyzed.mapping!.users['gl-bob']).toBe(bobId);
    expect(s.users.find((u) => u.id === 'gl-hana')!.name).toBe('Hana');
    expect(imp.report!.created).toMatchObject({ issues: 3, comments: 1, projects: 2 });

    const slow = await get('WEB-1');
    expect(slow).toMatchObject({ assigneeId: bobId, estimate: 3, dueDate: '2024-06-15' });
    expect(slow.links.map((l) => l.url)).toEqual(['https://gitlab.test/grp/sub/web/-/issues/1']);
    const group = await get('WEB-2');
    const [q3] = await app.db.select().from(projects).where(eq(projects.id, group.projectId!));
    expect(q3!.name).toBe('Q3 (group)');
    expect(group.completedAt).toBe('2024-05-10T08:00:00.000Z');
    const notes = await app.db.select().from(comments).where(eq(comments.issueId, slow.id));
    expect(notes.map((n) => n.body)).toEqual(['On it']);
  });
});
