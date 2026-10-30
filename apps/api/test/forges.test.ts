import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bootstrap, IssueDetail } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrations, users } from '../src/db/schema.ts';
import { parseCommit, parseReferences } from '../src/services/forge.ts';
import { schedulePolls } from '../src/services/integrations.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { startMockForge } from './mock-forge.ts';

let app: FastifyInstance;
let forge: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let ownerId: string;
let boot: Bootstrap;
const slug = `forge-${Date.now()}`;
const ws = `/api/w/${slug}`;
const team = () => boot.teams[0]!;
const stateId = (name: string) => team().states.find((s) => s.name === name)!.id;
const stateName = (id: string) => team().states.find((s) => s.id === id)?.name;

async function settle(rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

const newIssue = async (title: string, extra: Record<string, unknown> = {}) =>
  (await owner.post(`${ws}/issues`, { teamId: team().id, title, ...extra })).data as {
    id: string;
    identifier: string;
  };
const detail = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as IssueDetail;

beforeAll(async () => {
  forge = await startMockForge();
  process.env.ORDO_GITHUB_API_URL = forge.url;
  process.env.ORDO_GITHUB_URL = forge.url;
  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  owner = (await signup(app, 'Fern Owner')).client;
  ownerId = (await owner.get('/api/auth/me')).data.id;
  await owner.post('/api/workspaces', { name: 'Forge', slug, teamName: 'Alpha', teamKey: 'ALP' });
  boot = (await owner.get(`${ws}/bootstrap`)).data;
});
afterAll(async () => {
  delete process.env.ORDO_GITHUB_API_URL;
  delete process.env.ORDO_GITHUB_URL;
  await app.close();
  await forge.close();
});

describe('references and magic words', () => {
  it('reads branches, titles and closing words as moving; reference words as linking', () => {
    const r = parseReferences({
      branch: 'ada/alp-12-flux',
      title: 'ALP-13: tidy up',
      body: 'Fixes ALP-1, ALP-2 and alp-3.\nPart of ALP-4. Mentions ALP-5 in passing. closes: OPS-9',
    });
    expect([...r.closing].sort()).toEqual(['ALP-1', 'ALP-12', 'ALP-13', 'ALP-2', 'ALP-3', 'OPS-9']);
    expect([...r.referenced]).toEqual(['ALP-4']);
  });

  it('links every identifier in a commit, closing only with a closing word', () => {
    const c = parseCommit('ALP-7: refactor\n\nResolves ALP-8');
    expect([...c.closing]).toEqual(['ALP-8']);
    expect([...c.referenced]).toEqual(['ALP-7']);
  });
});

// ─── GitHub with a token ──────────────────────────────────────────────────

describe('GitHub (token)', () => {
  let integrationId: string;
  let hookPath: string;
  let secret: string;

  const deliver = (
    event: string,
    body: object,
    signWith = secret,
    delivery = `${Math.random()}`,
  ) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: hookPath,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': `sha256=${createHmac('sha256', signWith).update(raw).digest('hex')}`,
      },
    });
  };
  const pr = (extra: Record<string, unknown>) => ({
    number: 7,
    html_url: 'https://github.example/acme/app/pull/7',
    title: 'Flux work',
    body: '',
    state: 'open',
    draft: false,
    merged: false,
    updated_at: new Date().toISOString(),
    head: { ref: 'feature' },
    user: { id: 1, login: 'Ada-GH' },
    requested_reviewers: [],
    ...extra,
  });
  const repository = {
    full_name: 'acme/app',
    html_url: 'https://github.example/acme/app',
    default_branch: 'main',
  };

  beforeAll(async () => {
    forge.on('GET', '/repos/acme/app', { id: 1 });
    forge.on('POST', '/repos/acme/app/hooks', { id: 99 });
    forge.on('POST', '/repos/acme/app/issues/7/comments', { id: 1 });
  });

  it('checks the token and creates the repository webhook', async () => {
    const bad = await owner.post(`${ws}/integrations`, {
      provider: 'github',
      config: { repos: 'not a repo' },
      secrets: { token: 't' },
    });
    expect(bad.statusCode).toBe(400);
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'github',
      config: {
        repos: 'acme/app',
        apiUrl: forge.url,
        webUrl: 'https://github.example',
        commentOnPullRequests: true,
      },
      secrets: { token: 'ghp_test' },
    });
    expect(res.data.status).toBe('active');
    integrationId = res.data.id;
    hookPath = new URL(res.data.inboundUrl).pathname;
    const [created] = forge.calls('POST', '/repos/acme/app/hooks');
    expect(created!.headers.authorization).toBe('Bearer ghp_test');
    const body = created!.body as { config: { url: string; secret: string }; events: string[] };
    expect(body.config.url).toContain(hookPath);
    expect(body.events).toContain('pull_request');
    secret = body.config.secret;
  });

  it('lists every repository the token can see, page by page, for admins', async () => {
    const ghRepo = (name: string) => ({
      full_name: name,
      clone_url: `https://github.example/${name}.git`,
      ssh_url: `git@github.example:${name}.git`,
      default_branch: 'trunk',
      private: name.startsWith('acme/'),
    });
    // A full first page means there's another one.
    const first = Array.from({ length: 100 }, (_, i) =>
      ghRepo(`zed/r${String(i).padStart(3, '0')}`),
    );
    forge.on('GET', '/user/repos', (req: { path: string }) => ({
      body:
        new URL(req.path, 'http://x').searchParams.get('page') === '1'
          ? first
          : [ghRepo('acme/app')],
    }));
    const res = await owner.get(`${ws}/integrations/${integrationId}/repositories`);
    expect(res.statusCode).toBe(200);
    expect(res.data).toHaveLength(101);
    expect(res.data[0]).toEqual({
      fullName: 'acme/app',
      cloneUrl: 'https://github.example/acme/app.git',
      sshUrl: 'git@github.example:acme/app.git',
      defaultBranch: 'trunk',
      private: true,
    });
    const pages = forge.calls('GET', '/user/repos');
    expect(pages.map((p) => new URL(p.path, 'http://x').searchParams.get('page'))).toEqual([
      '1',
      '2',
    ]);
    expect(pages[0]!.headers.authorization).toBe('Bearer ghp_test');

    const found = await owner.get(`${ws}/integrations/${integrationId}/repositories?q=ACME`);
    expect(found.data.map((r: { fullName: string }) => r.fullName)).toEqual(['acme/app']);

    const memberToken = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
    const member = (await signup(app, 'Moss Member', { inviteToken: memberToken })).client;
    expect((await member.get(`${ws}/integrations/${integrationId}/repositories`)).statusCode).toBe(
      403,
    );
  });

  it('rejects unsigned deliveries', async () => {
    expect((await deliver('ping', {}, 'wrong-secret')).statusCode).toBe(401);
  });

  it('links a PR by branch name and moves the issue as it progresses', async () => {
    const issue = await newIssue('Flux capacitor');
    const ref = await newIssue('Related work');
    const n = issue.identifier.toLowerCase();
    await deliver('pull_request', {
      action: 'opened',
      repository,
      pull_request: pr({ head: { ref: `ada/${n}-flux` }, body: `Part of ${ref.identifier}` }),
    });
    await settle();
    let d = await detail(issue.id);
    expect(d.links).toMatchObject([
      { provider: 'github', kind: 'pull_request', state: 'open', author: 'Ada-GH' },
    ]);
    expect(stateName(d.stateId)).toBe('In Progress');
    // "Part of" links without moving.
    const r = await detail(ref.id);
    expect(r.links).toHaveLength(1);
    expect(stateName(r.stateId)).toBe(stateName(team().defaultStateId ?? r.stateId));
    // A comment links back, once.
    const comments = forge.calls('POST', '/repos/acme/app/issues/7/comments');
    expect(comments).toHaveLength(1);
    expect((comments[0]!.body as { body: string }).body).toContain(issue.identifier);

    await deliver('pull_request', {
      action: 'review_requested',
      repository,
      pull_request: pr({ head: { ref: `ada/${n}-flux` }, requested_reviewers: [{ login: 'bob' }] }),
    });
    await settle();
    expect(stateName((await detail(issue.id)).stateId)).toBe('In Review');

    await deliver('pull_request', {
      action: 'closed',
      repository,
      pull_request: pr({ head: { ref: `ada/${n}-flux` }, state: 'closed', merged: true }),
    });
    await settle();
    d = await detail(issue.id);
    expect(stateName(d.stateId)).toBe('Done');
    expect(d.links[0]!.state).toBe('merged');
    expect(forge.calls('POST', '/repos/acme/app/issues/7/comments')).toHaveLength(1);
  });

  it('never moves issues backwards', async () => {
    const done = await newIssue('Already shipped', { stateId: stateId('Done') });
    await deliver('pull_request', {
      action: 'opened',
      repository,
      pull_request: pr({ number: 8, title: `${done.identifier} follow-up` }),
    });
    await settle();
    expect(stateName((await detail(done.id)).stateId)).toBe('Done');
  });

  it('links commits and closes issues from the default branch', async () => {
    const onMain = await newIssue('Fixed on main');
    const onBranch = await newIssue('Fixed on a branch');
    const commit = (id: string, message: string) => ({
      id,
      message,
      url: `https://github.example/acme/app/commit/${id}`,
      author: { username: 'ada' },
    });
    await deliver('push', {
      ref: 'refs/heads/main',
      repository,
      commits: [commit('aaa111', `Fixes ${onMain.identifier}`)],
    });
    await deliver('push', {
      ref: `refs/heads/${onBranch.identifier.toLowerCase()}-wip`,
      created: true,
      repository,
      commits: [commit('bbb222', `Fixes ${onBranch.identifier}`)],
    });
    await settle();
    const m = await detail(onMain.id);
    expect(stateName(m.stateId)).toBe('Done');
    expect(m.links).toMatchObject([
      { kind: 'commit', title: expect.stringContaining('aaa111'.slice(0, 7)) },
    ]);
    const b = await detail(onBranch.id);
    expect(stateName(b.stateId)).not.toBe('Done');
    expect(b.links.map((l) => l.kind).sort()).toEqual(['branch', 'commit']);
  });

  it('credits people who claimed their username', async () => {
    const claim = await owner.post(`${ws}/me/external-accounts`, {
      provider: 'github',
      host: 'github.example',
      username: 'ada-gh',
    });
    expect(claim.statusCode).toBe(200);
    const services = (await owner.get(`${ws}/me/external-accounts`)).data.services;
    expect(services).toContainEqual({ provider: 'github', name: 'GitHub', host: 'github.example' });
    const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
    const other = (await signup(app, 'Ozzy Other', { inviteToken: invite.token })).client;
    expect(
      (
        await other.post(`${ws}/me/external-accounts`, {
          provider: 'github',
          host: 'github.example',
          username: 'ADA-GH',
        })
      ).statusCode,
    ).toBe(409);

    const issue = await newIssue('Credit');
    await deliver('pull_request', {
      action: 'opened',
      repository,
      pull_request: pr({ number: 9, title: `${issue.identifier} credit` }),
    });
    await settle();
    const [link] = (await detail(issue.id)).links;
    const [row] = await app.db.execute<{ author_user_id: string }>(
      sql`select author_user_id from issue_links where id = ${link!.id}`,
    );
    expect(row!.author_user_id).toBe(ownerId);
  });

  it('keeps old identifiers working after a team key change', async () => {
    const issue = await newIssue('Renamed');
    const oldId = issue.identifier;
    await owner.patch(`${ws}/teams/${team().id}`, { key: 'CORE' });
    expect((await owner.get(`${ws}/issues/${oldId}`)).data.id).toBe(issue.id);
    await deliver('pull_request', {
      action: 'opened',
      repository,
      pull_request: pr({ number: 10, head: { ref: `${oldId.toLowerCase()}-x` } }),
    });
    await settle();
    expect((await detail(issue.id)).links).toHaveLength(1);
    await owner.patch(`${ws}/teams/${team().id}`, { key: 'ALP' });
  });

  it('honours per-team automation, including "none"', async () => {
    const res = await owner.patch(`${ws}/teams/${team().id}`, {
      gitAutomation: { open: 'none', merged: stateId('In Review') },
    });
    expect(res.data.gitAutomation).toEqual({ open: 'none', merged: stateId('In Review') });
    expect(
      (
        await owner.patch(`${ws}/teams/${team().id}`, {
          gitAutomation: { open: '00000000-0000-4000-8000-000000000000' },
        })
      ).statusCode,
    ).toBe(400);
    const issue = await newIssue('Custom automation');
    const head = { ref: `${issue.identifier.toLowerCase()}-x` };
    await deliver('pull_request', {
      action: 'opened',
      repository,
      pull_request: pr({ number: 11, head }),
    });
    await settle();
    expect(stateName((await detail(issue.id)).stateId)).not.toBe('In Progress');
    await deliver('pull_request', {
      action: 'closed',
      repository,
      pull_request: pr({ number: 11, head, state: 'closed', merged: true }),
    });
    await settle();
    expect(stateName((await detail(issue.id)).stateId)).toBe('In Review');
    await owner.patch(`${ws}/teams/${team().id}`, { gitAutomation: {} });
  });

  it('polls instead when GitHub cannot reach Ordo', async () => {
    const issue = await newIssue('Polled');
    forge.on('GET', '/repos/acme/app/pulls', [
      pr({ number: 12, title: `${issue.identifier} polled`, updated_at: new Date().toISOString() }),
    ]);
    forge.on('GET', '/repos/acme/app/commits', []);
    forge.on('DELETE', '/repos/acme/app/hooks/99', {});
    await owner.patch(`${ws}/integrations/${integrationId}`, { config: { delivery: 'poll' } });
    expect(forge.calls('DELETE', '/repos/acme/app/hooks/99')).toHaveLength(1);
    await schedulePolls(app);
    await settle();
    expect((await detail(issue.id)).links).toMatchObject([{ state: 'open' }]);
    // The cursor keeps the next poll from redoing work.
    await app.db
      .update(integrations)
      .set({ lastPolledAt: null })
      .where(eq(integrations.id, integrationId));
    const before = forge.calls('POST', '/repos/acme/app/issues/12/comments').length;
    await schedulePolls(app);
    await settle();
    expect(forge.calls('POST', '/repos/acme/app/issues/12/comments').length).toBe(before);
  });
});

// ─── GitLab and Forgejo ───────────────────────────────────────────────────

describe('GitLab', () => {
  it('links merge requests and pushes from project webhooks', async () => {
    forge.on('GET', '/api/v4/projects/acme%2Fapp', { id: 5 });
    forge.on('POST', '/api/v4/projects/acme%2Fapp/hooks', { id: 55 });
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'gitlab',
      config: { baseUrl: forge.url, projects: 'acme/app' },
      secrets: { token: 'glpat' },
    });
    expect(res.data.status).toBe('active');
    const hook = forge.calls('POST', '/api/v4/projects/acme%2Fapp/hooks')[0]!;
    expect(hook.headers['private-token']).toBe('glpat');
    const token = (hook.body as { token: string }).token;
    const path = new URL(res.data.inboundUrl).pathname;
    const send = (event: string, body: object, t = token) =>
      app.inject({
        method: 'POST',
        url: path,
        payload: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          'x-gitlab-event': event,
          'x-gitlab-token': t,
        },
      });

    const issue = await newIssue('GitLab work');
    expect((await send('Merge Request Hook', {}, 'nope')).statusCode).toBe(401);
    await send('Merge Request Hook', {
      user: { id: 3, username: 'gl-user' },
      project: { path_with_namespace: 'acme/app' },
      object_attributes: {
        iid: 4,
        title: 'Draft: thing',
        description: `Closes ${issue.identifier}`,
        source_branch: 'x',
        state: 'opened',
        draft: true,
        url: 'https://gl.example/acme/app/-/merge_requests/4',
        action: 'open',
      },
      reviewers: [],
    });
    await settle();
    let d = await detail(issue.id);
    expect(d.links).toMatchObject([{ provider: 'gitlab', state: 'draft', author: 'gl-user' }]);
    expect(stateName(d.stateId)).toBe('In Progress');
    await send('Merge Request Hook', {
      user: { id: 9, username: 'merger' },
      project: { path_with_namespace: 'acme/app' },
      object_attributes: {
        iid: 4,
        title: 'thing',
        description: `Closes ${issue.identifier}`,
        source_branch: 'x',
        state: 'merged',
        url: 'https://gl.example/acme/app/-/merge_requests/4',
        action: 'merge',
      },
    });
    await settle();
    d = await detail(issue.id);
    expect(stateName(d.stateId)).toBe('Done');
    // The author from "open" is kept: a later event's user isn't the author.
    expect(d.links[0]).toMatchObject({ state: 'merged', author: 'gl-user' });
  });
});

describe('Forgejo', () => {
  it('says why it could not connect', async () => {
    // A port that was just free: nothing listens there.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'forgejo',
      config: { baseUrl: `http://127.0.0.1:${port}`, repos: 'acme/app', delivery: 'poll' },
      secrets: { token: 'fj' },
    });
    expect(res.data).toMatchObject({
      status: 'error',
      lastError: `127.0.0.1:${port}: couldn't connect (ECONNREFUSED)`,
    });
    await owner.del(`${ws}/integrations/${res.data.id}`);
  });

  it('verifies signatures and treats WIP titles as drafts', async () => {
    forge.on('GET', '/api/v1/repos/acme/app', { id: 5 });
    forge.on('POST', '/api/v1/repos/acme/app/hooks', { id: 77 });
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'forgejo',
      config: { baseUrl: forge.url, repos: 'acme/app' },
      secrets: { token: 'fj' },
    });
    expect(res.data.status).toBe('active');
    const hook = forge.calls('POST', '/api/v1/repos/acme/app/hooks')[0]!;
    expect(hook.headers.authorization).toBe('token fj');
    const secret = (hook.body as { config: { secret: string } }).config.secret;
    const path = new URL(res.data.inboundUrl).pathname;
    const issue = await newIssue('Forgejo work');
    const raw = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'acme/app',
        html_url: 'https://code.example/acme/app',
        default_branch: 'main',
      },
      pull_request: {
        number: 3,
        html_url: 'https://code.example/acme/app/pulls/3',
        title: `WIP: ${issue.identifier} start`,
        body: '',
        state: 'open',
        merged: false,
        updated_at: new Date().toISOString(),
        head: { ref: 'x' },
        user: { id: 2, login: 'fj-user' },
      },
    });
    const send = (sig: string) =>
      app.inject({
        method: 'POST',
        url: path,
        payload: raw,
        headers: {
          'content-type': 'application/json',
          'x-forgejo-event': 'pull_request',
          'x-forgejo-delivery': 'd1',
          'x-forgejo-signature': sig,
        },
      });
    expect((await send('00')).statusCode).toBe(401);
    expect((await send(createHmac('sha256', secret).update(raw).digest('hex'))).statusCode).toBe(
      202,
    );
    await settle();
    const d = await detail(issue.id);
    expect(d.links).toMatchObject([{ provider: 'forgejo', state: 'draft', author: 'fj-user' }]);

    // A server whose page cap is below our limit returns short pages; keep going until empty.
    const fjRepo = (name: string) => ({
      full_name: name,
      clone_url: `${forge.url}/${name}.git`,
      ssh_url: `git@code.example:${name}.git`,
      default_branch: 'main',
      private: false,
    });
    forge.on('GET', '/api/v1/user/repos', (req: { path: string }) => ({
      body:
        (
          {
            '1': [fjRepo('acme/app')],
            '2': [fjRepo('acme/web')],
          } as Record<string, unknown[]>
        )[new URL(req.path, 'http://x').searchParams.get('page') ?? ''] ?? [],
    }));
    const repos = await owner.get(`${ws}/integrations/${res.data.id}/repositories`);
    expect(
      forge
        .calls('GET', '/api/v1/user/repos')
        .map((p) => new URL(p.path, 'http://x').searchParams.get('page')),
    ).toEqual(['1', '2', '3']);
    expect(repos.data.map((r: { fullName: string }) => r.fullName)).toEqual([
      'acme/app',
      'acme/web',
    ]);
    expect(repos.data[0]).toEqual({
      fullName: 'acme/app',
      cloneUrl: `${forge.url}/acme/app.git`,
      sshUrl: 'git@code.example:acme/app.git',
      defaultBranch: 'main',
      private: false,
    });
    expect(forge.calls('GET', '/api/v1/user/repos')[0]!.headers.authorization).toBe('token fj');

    // A forge that says no is a 400 with its reason, not a server error.
    forge.on('GET', '/api/v1/user/repos', () => ({
      status: 401,
      body: { message: 'token is invalid' },
    }));
    const denied = await owner.get(`${ws}/integrations/${res.data.id}/repositories`);
    expect(denied.statusCode).toBe(400);
    expect(denied.data.message ?? denied.data.error).toContain('token is invalid');
  });
});

// ─── GitHub App ───────────────────────────────────────────────────────────

describe('GitHub App', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  it('is created from a manifest, installed, and receives webhooks for its installation', async () => {
    // Creating the app is for instance admins.
    await app.db.update(users).set({ isInstanceAdmin: false }).where(eq(users.id, ownerId));
    expect((await owner.post(`${ws}/integrations/github/manifest`, {})).statusCode).toBe(403);
    await app.db.update(users).set({ isInstanceAdmin: true }).where(eq(users.id, ownerId));
    const manifest = await owner.post(`${ws}/integrations/github/manifest`, {});
    expect(manifest.statusCode).toBe(200);
    const parsed = JSON.parse(manifest.data.manifest);
    const appRowId = parsed.hook_attributes.url.split('/app-')[1];
    const state = new URL(manifest.data.action).searchParams.get('state')!;

    forge.on('POST', '/app-manifests/the-code/conversions', {
      id: 4242,
      slug: 'ordo-test',
      name: 'Ordo test',
      html_url: `${forge.url}/apps/ordo-test`,
      pem: privateKey,
      webhook_secret: 'app-hook-secret',
      client_id: 'Iv1.x',
      client_secret: 'shh',
    });
    const back = await owner.get(`/api/integrations/github/callback?code=the-code&state=${state}`);
    expect(back.statusCode).toBe(302);
    const install = new URL(back.headers.location as string);
    expect(install.pathname).toBe('/apps/ordo-test/installations/new');
    // The state is single-use.
    expect(
      (await owner.get(`/api/integrations/github/callback?code=the-code&state=${state}`)).headers
        .location,
    ).toContain('error=');

    const setup = await owner.get(
      `/api/integrations/github/setup?installation_id=42&setup_action=install&state=${install.searchParams.get('state')}`,
    );
    expect(setup.headers.location).toBe(`/${slug}/settings/integrations`);
    await app.db.update(users).set({ isInstanceAdmin: false }).where(eq(users.id, ownerId));

    forge.on('POST', '/app/installations/42/access_tokens', {
      token: 'ghs_installation',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    forge.on('POST', '/repos/acme/app/issues/21/comments', { id: 2 });
    const issue = await newIssue('Via the app');
    const raw = JSON.stringify({
      action: 'opened',
      installation: { id: 42 },
      repository: {
        full_name: 'acme/app',
        html_url: 'https://github.example/acme/app',
        default_branch: 'main',
      },
      pull_request: {
        number: 21,
        html_url: 'https://github.example/acme/app/pull/21',
        title: `${issue.identifier} via app`,
        body: '',
        state: 'open',
        updated_at: new Date().toISOString(),
        head: { ref: 'x' },
        user: { id: 1, login: 'ada' },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/hooks/github/app-${appRowId}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'app-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-hook-secret').update(raw).digest('hex')}`,
      },
    });
    expect(res.statusCode).toBe(202);
    await settle();
    expect((await detail(issue.id)).links).toMatchObject([{ provider: 'github', state: 'open' }]);

    // The installation token came from a JWT signed with the app's key.
    const tokenCall = forge.calls('POST', '/app/installations/42/access_tokens')[0]!;
    const jwt = String(tokenCall.headers.authorization).replace('Bearer ', '');
    const { payload } = await jwtVerify(
      jwt,
      (await import('node:crypto')).createPublicKey(publicKey),
    );
    expect(payload.iss).toBe('4242');
    expect(
      forge.calls('POST', '/repos/acme/app/issues/21/comments')[0]!.headers.authorization,
    ).toBe('Bearer ghs_installation');

    // Installations list the repositories they were granted.
    forge.on('GET', '/installation/repositories', {
      total_count: 1,
      repositories: [
        {
          full_name: 'acme/app',
          clone_url: 'https://github.example/acme/app.git',
          ssh_url: 'git@github.example:acme/app.git',
          default_branch: 'main',
          private: true,
        },
      ],
    });
    const { integrations: list } = (await owner.get(`${ws}/integrations`)).data as {
      integrations: { id: string; config: { mode?: string } }[];
    };
    const installed = list.find((i) => i.config.mode === 'app')!;
    const repos = await owner.get(`${ws}/integrations/${installed.id}/repositories`);
    expect(repos.data).toMatchObject([{ fullName: 'acme/app', defaultBranch: 'main' }]);
    expect(forge.calls('GET', '/installation/repositories')[0]!.headers.authorization).toBe(
      'Bearer ghs_installation',
    );
  });
});
