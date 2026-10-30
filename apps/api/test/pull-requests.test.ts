import { createHmac } from 'node:crypto';
import type { AgentRun, AgentRunContext, Bootstrap, IssueDetail } from '@ordo/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns, issues } from '../src/db/schema.ts';
import { type Client, signup, testApp } from './helpers.ts';
import { startMockForge } from './mock-forge.ts';

/** Pull requests on issues: checks and reviews, the project's PR agent, and follow-up runs. */

let app: FastifyInstance;
let forge: Awaited<ReturnType<typeof startMockForge>>;
let owner: Client;
let ownerId: string;
let boot: Bootstrap;
let hookPath: string;
let secret: string;
let integrationId: string;
let repoId: string;
let projectId: string;
let coder: { id: string; key: string };
let integrator: { id: string; key: string };
const slug = `prs-${Date.now()}`;
const ws = `/api/w/${slug}`;
const team = () => boot.teams[0]!;
const repository = {
  full_name: 'acme/app',
  html_url: 'https://github.example/acme/app',
  default_branch: 'main',
};

/** What GET .../check-runs answers, per sha. */
const checkRuns = new Map<string, { status: string; conclusion: string | null }[]>();

async function settle() {
  await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
  await app.jobs.drain();
}

function deliver(event: string, body: object) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: hookPath,
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': `${Math.random()}`,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
  });
}

let nextNumber = 100;
/** A PR payload; each test takes fresh numbers from `nextNumber`. */
const pull = (extra: Record<string, unknown> & { number: number }) => ({
  html_url: `https://github.example/acme/app/pull/${extra.number}`,
  title: 'Some work',
  body: '',
  state: 'open',
  draft: false,
  merged: false,
  updated_at: new Date().toISOString(),
  head: { ref: 'feature', sha: 'sha-1' },
  user: { id: 1, login: 'ada' },
  requested_reviewers: [],
  ...extra,
});
const openPr = async (pr: ReturnType<typeof pull>, action = 'opened') => {
  await deliver('pull_request', { action, repository, pull_request: pr });
  await settle();
};
const checksDone = async (sha: string, numbers: number[]) => {
  await deliver('check_suite', {
    action: 'completed',
    repository,
    check_suite: { head_sha: sha, pull_requests: numbers.map((number) => ({ number })) },
  });
  await settle();
};
const review = async (pr: ReturnType<typeof pull>, state: string) => {
  await deliver('pull_request_review', {
    action: 'submitted',
    repository,
    review: { state },
    pull_request: pr,
  });
  await settle();
};

const newIssue = async (title: string, extra: Record<string, unknown> = {}) =>
  (await owner.post(`${ws}/issues`, { teamId: team().id, title, ...extra })).data as {
    id: string;
    identifier: string;
  };
const detail = async (id: string) => (await owner.get(`${ws}/issues/${id}`)).data as IssueDetail;
const runsOf = async (issueId: string) =>
  (await owner.get(`${ws}/issues/${issueId}/agent-runs`)).data as AgentRun[];
const finishRuns = (issueId: string) =>
  app.db
    .update(agentRuns)
    .set({ status: 'succeeded', finishedAt: new Date().toISOString() })
    .where(eq(agentRuns.issueId, issueId));

async function makeAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await owner.post(`${ws}/agents`, { name, teamIds: [team().id], ...extra });
  const key = (await owner.post(`${ws}/agents/${res.data.id}/keys`, { name: 'k' })).data.token;
  return { id: res.data.id as string, key: key as string };
}

beforeAll(async () => {
  forge = await startMockForge();
  process.env.ORDO_GITHUB_API_URL = forge.url;
  process.env.ORDO_GITHUB_URL = forge.url;
  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  owner = (await signup(app, 'Pia Owner')).client;
  ownerId = (await owner.get('/api/auth/me')).data.id;
  await owner.post('/api/workspaces', { name: 'PRs', slug, teamName: 'Alpha', teamKey: 'PRA' });
  boot = (await owner.get(`${ws}/bootstrap`)).data;

  forge.on('GET', '/repos/acme/app', { id: 1 });
  forge.on('POST', '/repos/acme/app/hooks', { id: 5 });
  forge.onPrefix('GET', '/repos/acme/app/commits/', (req: { path: string }) => {
    const [, sha, what] = new URL(req.path, 'http://x').pathname.match(
      /commits\/([^/]+)\/(check-runs|status)$/,
    )!;
    return {
      body:
        what === 'status'
          ? { statuses: [] }
          : { check_runs: checkRuns.get(sha!) ?? [{ status: 'in_progress', conclusion: null }] },
    };
  });
  const res = await owner.post(`${ws}/integrations`, {
    provider: 'github',
    config: { repos: 'acme/app', apiUrl: forge.url, webUrl: 'https://github.example' },
    secrets: { token: 'ghp_test' },
  });
  integrationId = res.data.id;
  hookPath = new URL(res.data.inboundUrl).pathname;
  const hook = forge.calls('POST', '/repos/acme/app/hooks')[0]!.body as {
    config: { secret: string };
    events: string[];
  };
  secret = hook.config.secret;
  expect(hook.events).toEqual(expect.arrayContaining(['check_suite', 'status']));

  repoId = (
    await owner.post(`${ws}/repositories`, {
      name: 'app',
      url: 'https://github.example/acme/app.git',
      integrationId,
      externalRepo: 'acme/app',
    })
  ).data.id;
  projectId = (
    await owner.post(`${ws}/projects`, {
      name: 'Shipping',
      teamIds: [team().id],
      repositoryIds: [repoId],
    })
  ).data.id;
  coder = await makeAgent('Coder');
  integrator = await makeAgent('Integrator');
});
afterAll(async () => {
  delete process.env.ORDO_GITHUB_API_URL;
  delete process.env.ORDO_GITHUB_URL;
  await app.close();
  await forge.close();
});

describe('checks and reviews', () => {
  it('follows checks on the head commit and keeps what later events leave out', async () => {
    const issue = await newIssue('Checks');
    const number = nextNumber++;
    const pr = pull({ number, head: { ref: `ada/${issue.identifier.toLowerCase()}`, sha: 'c1' } });
    await openPr(pr);
    expect((await detail(issue.id)).links[0]!.pullRequest).toEqual({
      repo: 'acme/app',
      number,
      branch: pr.head.ref,
      checks: null,
      review: null,
    });

    checkRuns.set('c1', [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
    ]);
    await checksDone('c1', [number]);
    expect((await detail(issue.id)).links[0]!.pullRequest!.checks).toBe('failing');

    // Results for an older commit say nothing about the PR.
    checkRuns.set('c0', [{ status: 'completed', conclusion: 'success' }]);
    await checksDone('c0', [number]);
    expect((await detail(issue.id)).links[0]!.pullRequest!.checks).toBe('failing');

    await review(pr, 'approved');
    await openPr(pr, 'edited');
    expect((await detail(issue.id)).links[0]!.pullRequest).toMatchObject({
      checks: 'failing',
      review: 'approved',
    });

    // A new head commit hasn't got checks yet.
    await openPr({ ...pr, head: { ...pr.head, sha: 'c2' } }, 'synchronize');
    expect((await detail(issue.id)).links[0]!.pullRequest!.checks).toBeNull();
  });

  it('matches checks without a PR number (forks) by head sha', async () => {
    const issue = await newIssue('Fork');
    const number = nextNumber++;
    await openPr(
      pull({ number, title: `${issue.identifier} from a fork`, head: { ref: 'x', sha: 'f1' } }),
    );
    checkRuns.set('f1', [{ status: 'completed', conclusion: 'success' }]);
    await checksDone('f1', []);
    expect((await detail(issue.id)).links[0]!.pullRequest!.checks).toBe('passing');
  });

  it('keeps a PR linked after its title stops naming the issue', async () => {
    const issue = await newIssue('Renamed');
    const number = nextNumber++;
    await openPr(
      pull({ number, title: `${issue.identifier}: first try`, head: { ref: 'y', sha: 'r1' } }),
    );
    await openPr(
      pull({ number, title: 'Better title', state: 'closed', head: { ref: 'y', sha: 'r1' } }),
      'closed',
    );
    expect((await detail(issue.id)).links[0]!.state).toBe('closed');
  });
});

describe("a project's pull request agent", () => {
  const setAgent = (body: object) => owner.patch(`${ws}/projects/${projectId}`, body);

  it('must be an agent in one of the project’s teams, set by an admin', async () => {
    const other = (await owner.post(`${ws}/teams`, { name: 'Other', key: 'OTH' })).data.id;
    const outsider = (await owner.post(`${ws}/agents`, { name: 'Outsider', teamIds: [other] })).data
      .id;
    expect((await setAgent({ pullRequestAgentId: outsider })).statusCode).toBe(400);
    expect((await setAgent({ pullRequestAgentId: ownerId })).statusCode).toBe(400);
    const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
    const member = (await signup(app, 'Mo Member', { inviteToken: invite })).client;
    expect(
      (await member.patch(`${ws}/projects/${projectId}`, { pullRequestAgentId: integrator.id }))
        .statusCode,
    ).toBe(403);
    const ok = await setAgent({ pullRequestAgentId: integrator.id });
    expect(ok.statusCode).toBe(200);
    expect(ok.data).toMatchObject({
      pullRequestAgentId: integrator.id,
      pullRequestScope: 'linked',
    });
  });

  it('takes over from the coder when the PR is ready for review, once', async () => {
    const issue = await newIssue('Handoff', { projectId, assigneeId: coder.id });
    const number = nextNumber++;
    const pr = pull({
      number,
      draft: true,
      head: { ref: `coder/${issue.identifier.toLowerCase()}`, sha: 'h1' },
    });
    await openPr(pr);
    expect((await detail(issue.id)).assigneeId).toBe(coder.id);

    await openPr({ ...pr, draft: false }, 'ready_for_review');
    expect((await detail(issue.id)).assigneeId).toBe(integrator.id);
    let runs = await runsOf(issue.id);
    const mine = runs.filter((r) => r.agentId === integrator.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      status: 'queued',
      trigger: 'pull_request',
      triggerDetail: { event: 'ready_for_review', repo: 'acme/app', number, branch: pr.head.ref },
    });
    expect(runs.find((r) => r.agentId === coder.id)?.status).toBe('cancelled');

    // The integrator's run sees the PR and works on its branch.
    const res = await app.inject({
      method: 'POST',
      url: `${ws}/agent/claim`,
      headers: { authorization: `Bearer ${integrator.key}` },
    });
    const ctx = res.json() as AgentRunContext;
    expect(ctx.trigger.pullRequest).toMatchObject({ event: 'ready_for_review', number });
    expect(ctx.pullRequests).toMatchObject([{ repo: 'acme/app', number, branch: pr.head.ref }]);
    expect(ctx.repositories[0]!.suggestedBranch).toBe(pr.head.ref);
    expect(ctx.prompt).toContain(`acme/app#${number}`);
    expect(ctx.prompt).toContain('ready for review');

    // Back to draft and ready again: still handed off only once.
    await finishRuns(issue.id);
    await openPr({ ...pr, draft: true }, 'converted_to_draft');
    await openPr({ ...pr, draft: false }, 'ready_for_review');
    runs = await runsOf(issue.id);
    expect(runs.filter((r) => r.agentId === integrator.id)).toHaveLength(1);
  });

  it('gives an unassigned issue to the agent, and leaves a person’s issue with them', async () => {
    const free = await newIssue('Nobody has it', { projectId, assigneeId: null });
    await openPr(pull({ number: nextNumber++, title: `${free.identifier} work` }));
    expect((await detail(free.id)).assigneeId).toBe(integrator.id);

    const mine = await newIssue('Pia has it', { projectId, assigneeId: ownerId });
    await openPr(pull({ number: nextNumber++, title: `${mine.identifier} work` }));
    expect((await detail(mine.id)).assigneeId).toBe(ownerId);
    expect(await runsOf(mine.id)).toMatchObject([
      { agentId: integrator.id, trigger: 'pull_request', status: 'queued' },
    ]);
  });

  it('leaves issues outside the project alone', async () => {
    const elsewhere = await newIssue('No project', { assigneeId: coder.id });
    await openPr(pull({ number: nextNumber++, title: `${elsewhere.identifier} work` }));
    expect((await detail(elsewhere.id)).assigneeId).toBe(coder.id);
  });

  it('gets an issue for a PR that links none, with scope "all"', async () => {
    const count = async () =>
      (
        await app.db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.projectId, projectId), sql`${issues.title} like 'acme/app#%'`))
      ).length;
    const number = nextNumber++;
    const outside = pull({ number, title: 'Bump left-pad', user: { id: 9, login: 'dependabot' } });
    await openPr(outside);
    expect(await count()).toBe(0); // scope "linked"

    await setAgent({ pullRequestScope: 'all' });
    const other = nextNumber++;
    const pr = pull({ number: other, title: 'Bump left-pad', head: { ref: 'deps', sha: 'd1' } });
    await openPr(pr);
    await openPr(pr, 'review_requested'); // a redelivery doesn't make another
    expect(await count()).toBe(1);
    const [made] = await app.db
      .select()
      .from(issues)
      .where(eq(issues.title, `acme/app#${other}: Bump left-pad`));
    expect(made).toMatchObject({ teamId: team().id, assigneeId: integrator.id });
    const d = await detail(made!.id);
    expect(d.links).toMatchObject([{ kind: 'pull_request', state: 'review' }]);
    expect(d.description).toContain(pr.html_url);
    expect(await runsOf(made!.id)).toMatchObject([
      { trigger: 'pull_request', triggerDetail: { event: 'ready_for_review', number: other } },
    ]);
    // Drafts wait until they're ready.
    await openPr(pull({ number: nextNumber++, title: 'WIP thing', draft: true }));
    expect(await count()).toBe(1);
    await setAgent({ pullRequestScope: 'linked' });
  });
});

describe('follow-ups for the assignee', () => {
  it('wakes the agent when checks start failing or changes are requested', async () => {
    const issue = await newIssue('Follow me', { assigneeId: coder.id });
    await finishRuns(issue.id);
    const number = nextNumber++;
    const pr = pull({ number, title: `${issue.identifier} fix`, head: { ref: 'f', sha: 'w1' } });
    await openPr(pr);
    checkRuns.set('w1', [{ status: 'completed', conclusion: 'failure' }]);
    await checksDone('w1', [number]);
    let runs = (await runsOf(issue.id)).filter((r) => r.status === 'queued');
    expect(runs).toMatchObject([
      { agentId: coder.id, trigger: 'pull_request', triggerDetail: { event: 'checks_failed' } },
    ]);
    // Still failing is no news.
    await finishRuns(issue.id);
    await checksDone('w1', [number]);
    expect((await runsOf(issue.id)).filter((r) => r.status === 'queued')).toHaveLength(0);

    await review(pr, 'changes_requested');
    runs = (await runsOf(issue.id)).filter((r) => r.status === 'queued');
    expect(runs).toMatchObject([{ triggerDetail: { event: 'changes_requested' } }]);
  });

  it('stops after three in a row, and says so once', async () => {
    const issue = await newIssue('Loop', { assigneeId: coder.id });
    await finishRuns(issue.id);
    const number = nextNumber++;
    const pr = pull({ number, title: `${issue.identifier} loop`, head: { ref: 'l', sha: 'l0' } });
    await openPr(pr);
    for (let i = 1; i <= 5; i++) {
      const sha = `l${i}`;
      await openPr({ ...pr, head: { ...pr.head, sha } }, 'synchronize');
      checkRuns.set(sha, [{ status: 'completed', conclusion: 'failure' }]);
      await checksDone(sha, [number]);
      await finishRuns(issue.id);
    }
    const runs = await runsOf(issue.id);
    expect(runs.filter((r) => r.trigger === 'pull_request')).toHaveLength(3);
    const said = (
      (await owner.get(`${ws}/issues/${issue.id}/comments`)).data as { body: string }[]
    ).filter((c) => c.body.includes('Stopped asking'));
    expect(said).toHaveLength(1);
  });

  it('leaves people and agents that opted out alone', async () => {
    const quiet = await makeAgent('Quiet', { followPullRequests: false });
    expect(
      (await owner.get(`${ws}/agents`)).data.find((a: { id: string }) => a.id === quiet.id),
    ).toMatchObject({ followPullRequests: false });
    for (const assigneeId of [quiet.id, ownerId]) {
      const issue = await newIssue('Quiet', { assigneeId });
      await finishRuns(issue.id);
      const number = nextNumber++;
      const sha = `q-${assigneeId}`;
      await openPr(pull({ number, title: `${issue.identifier} q`, head: { ref: 'q', sha } }));
      checkRuns.set(sha, [{ status: 'completed', conclusion: 'failure' }]);
      await checksDone(sha, [number]);
      const queued = await app.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.issueId, issue.id), inArray(agentRuns.status, ['queued'])));
      expect(queued).toHaveLength(0);
    }
  });
});
