import type { AgentRun, AgentRunContext, Bootstrap, Comment } from '@ordo/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns, domainEvents } from '../src/db/schema.ts';
import { reapLeases } from '../src/services/agents.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let member: Client;
let boot: Bootstrap;
const slug = `ag-${Date.now()}`;
const ws = `/api/w/${slug}`;
let eng: string;
let prv: string;
let agentId: string;
let key: string;

/** A request with an API key instead of a session. */
async function bearer(token: string, method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as object,
    headers: { authorization: `Bearer ${token}` },
  });
  // biome-ignore lint/suspicious/noExplicitAny: response bodies, as in helpers.ts
  let data: any = null;
  try {
    data = res.json();
  } catch {}
  return Object.assign(res, { data });
}
const agent = (method: string, url: string, body?: unknown) => bearer(key, method, url, body);
const claim = (wait = 0) =>
  agent('POST', `${ws}/agent/claim?wait=${wait}&runner=test-host`) as Promise<{
    statusCode: number;
    data: AgentRunContext;
  }>;
const runsOf = async (issueId: string) =>
  (await owner.get(`${ws}/issues/${issueId}/agent-runs`)).data as AgentRun[];
const issue = async (title: string, extra: Record<string, unknown> = {}) =>
  (await owner.post(`${ws}/issues`, { teamId: eng, title, ...extra })).data as {
    id: string;
    identifier: string;
  };

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Ada Owner')).client;
  await owner.post('/api/workspaces', { name: 'Agents', slug, teamName: 'Eng', teamKey: 'ENG' });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Max Member', { inviteToken: invite })).client;
  prv = (await owner.post(`${ws}/teams`, { name: 'Private', key: 'PRV', private: true })).data.id;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  eng = boot.teams.find((t) => t.key === 'ENG')!.id;
});
afterAll(() => app.close());

describe('agent accounts', () => {
  it('lets admins create agents that are guests of their teams', async () => {
    expect((await member.post(`${ws}/agents`, { name: 'Nope', teamIds: [eng] })).statusCode).toBe(
      403,
    );
    const res = await owner.post(`${ws}/agents`, {
      name: 'Claude',
      teamIds: [eng],
      instructions: 'Run the tests before opening a PR.',
    });
    expect(res.statusCode).toBe(200);
    agentId = res.data.id;
    expect(res.data).toMatchObject({ name: 'Claude', teamIds: [eng], concurrency: 1, keys: [] });

    const members = (await owner.get(`${ws}/bootstrap`)).data.members as Bootstrap['members'];
    expect(members.find((m) => m.id === agentId)).toMatchObject({ kind: 'agent', role: 'guest' });
    expect(members.find((m) => m.name === 'Ada Owner')).toMatchObject({ kind: 'human' });
  });

  it('keeps what an update leaves out', async () => {
    const res = await owner.patch(`${ws}/agents/${agentId}`, { concurrency: 1 });
    expect(res.data).toMatchObject({
      instructions: 'Run the tests before opening a PR.',
      teamIds: [eng],
    });
  });

  it('issues keys that authenticate the agent in its workspace only', async () => {
    const created = await owner.post(`${ws}/agents/${agentId}/keys`, { name: 'laptop' });
    key = created.data.token;
    expect(key).toMatch(/^ordo_/);
    expect((await owner.get(`${ws}/agents`)).data[0].keys).toHaveLength(1);

    const me = await agent('GET', `${ws}/agent/me`);
    expect(me.data).toMatchObject({
      id: agentId,
      name: 'Claude',
      workspace: { slug },
      teams: [{ key: 'ENG' }],
    });
    // Nothing outside the workspace: no account, no new keys, no workspaces of its own.
    // Who-am-I works, so the CLI does; the rest of the account doesn't.
    expect((await agent('GET', '/api/auth/me')).data).toMatchObject({
      id: agentId,
      workspaces: [{ slug, role: 'guest' }],
    });
    expect((await agent('PATCH', '/api/me', { name: 'Evil' })).statusCode).toBe(401);
    expect((await agent('POST', '/api/me/api-keys', { name: 'more' })).statusCode).toBe(401);
    expect((await agent('POST', '/api/workspaces', { name: 'x', slug: 'x-ag' })).statusCode).toBe(
      401,
    );
    // And only its teams inside it.
    const hidden = (await owner.post(`${ws}/issues`, { teamId: prv, title: 'Secret' })).data;
    expect((await agent('GET', `${ws}/issues/${hidden.id}`)).statusCode).toBe(404);
  });

  it('keeps the runner endpoints for agents', async () => {
    expect((await owner.post(`${ws}/agent/claim`)).statusCode).toBe(403);
    const personal = (await owner.post('/api/me/api-keys', { name: 'mine' })).data.token;
    expect((await bearer(personal, 'POST', `${ws}/agent/claim`)).statusCode).toBe(403);
  });

  it('is managed as an agent, not as a member', async () => {
    expect((await owner.patch(`${ws}/members/${agentId}`, { role: 'admin' })).statusCode).toBe(400);
    expect((await owner.del(`${ws}/members/${agentId}`)).statusCode).toBe(400);
  });

  it("can't be assigned outside its teams", async () => {
    const res = await owner.post(`${ws}/issues`, {
      teamId: prv,
      title: 'Not for agents',
      assigneeId: agentId,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('repositories', () => {
  let api: string;
  let web: string;

  it('are managed by admins and listed for everyone', async () => {
    expect(
      (await member.post(`${ws}/repositories`, { name: 'x', url: 'https://example.com/x.git' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await owner.post(`${ws}/repositories`, { name: 'bad', url: 'not a url' })).statusCode,
    ).toBe(400);
    api = (
      await owner.post(`${ws}/repositories`, {
        name: 'api',
        url: 'git@git.example.com:acme/api.git',
      })
    ).data.id;
    web = (
      await owner.post(`${ws}/repositories`, {
        name: 'web',
        url: 'https://git.example.com/acme/web.git',
        defaultBranch: 'trunk',
      })
    ).data.id;
    // Changing one field leaves the others as they were.
    await owner.patch(`${ws}/repositories/${web}`, { name: 'web' });
    const listed = (await member.get(`${ws}/bootstrap`)).data.repositories;
    expect(listed.find((r: { name: string }) => r.name === 'web').defaultBranch).toBe('trunk');
    expect(listed.map((r: { name: string }) => r.name)).toEqual(['api', 'web']);
  });

  it('come from the project, else the team default', async () => {
    expect((await owner.patch(`${ws}/teams/${eng}`, { defaultRepositoryId: api })).statusCode).toBe(
      200,
    );
    const project = (
      await owner.post(`${ws}/projects`, { name: 'Site', teamIds: [eng], repositoryIds: [web] })
    ).data;
    expect(project.repositoryIds).toEqual([web]);

    const inProject = await issue('Make the site faster', {
      projectId: project.id,
      assigneeId: agentId,
    });
    const run = await claim();
    expect(run.statusCode).toBe(200);
    expect(run.data.issue.id).toBe(inProject.id);
    expect(run.data.repositories).toEqual([
      expect.objectContaining({
        name: 'web',
        defaultBranch: 'trunk',
        suggestedBranch: expect.stringMatching(/^claude[\w-]*\/eng-\d+-make-the-site-faster$/),
      }),
    ]);
    expect(run.data.project).toMatchObject({ name: 'Site' });
    await agent('PATCH', `${ws}/agent/runs/${run.data.run.id}`, { status: 'succeeded' });

    const loose = await issue('Fix the API', { assigneeId: agentId });
    const second = await claim();
    expect(second.data.issue.id).toBe(loose.id);
    expect(second.data.repositories.map((r) => r.name)).toEqual(['api']);
    await agent('PATCH', `${ws}/agent/runs/${second.data.run.id}`, { status: 'succeeded' });
  });

  it("can't point at another workspace's repository", async () => {
    const other = (await signup(app, 'Oscar Other')).client;
    await other.post('/api/workspaces', {
      name: 'O',
      slug: `${slug}-o`,
      teamName: 'O',
      teamKey: 'O',
    });
    const foreign = (
      await other.post(`/api/w/${slug}-o/repositories`, {
        name: 'theirs',
        url: 'https://example.com/theirs.git',
      })
    ).data.id;
    expect(
      (await owner.patch(`${ws}/teams/${eng}`, { defaultRepositoryId: foreign })).statusCode,
    ).toBe(400);
    expect((await owner.get(`${ws}/repositories`)).data).toHaveLength(2);
  });
});

describe('runs', () => {
  it('are queued on assignment and handed out with everything a runner needs', async () => {
    const i = await issue('Write the changelog', { description: 'For **v2**.' });
    expect(await runsOf(i.id)).toEqual([]);
    await owner.post(`${ws}/issues/${i.id}/comments`, { body: 'Keep it short.' });
    await owner.patch(`${ws}/issues/${i.id}`, { assigneeId: agentId });
    expect(await runsOf(i.id)).toEqual([expect.objectContaining({ status: 'queued' })]);

    const { statusCode, data } = await claim();
    expect(statusCode).toBe(200);
    expect(data.protocolVersion).toBe(1);
    expect(data.run).toMatchObject({ status: 'claimed', attempts: 1, runnerName: 'test-host' });
    expect(data.issue).toMatchObject({ identifier: i.identifier, team: { key: 'ENG' } });
    expect(data.issue.url).toContain(`/${slug}/issue/${i.identifier}`);
    expect(data.comments).toEqual([expect.objectContaining({ body: 'Keep it short.' })]);
    expect(data.agent.instructions).toBe('Run the tests before opening a PR.');
    expect(data.states.map((s) => s.type)).toContain('started');
    expect(data.prompt).toContain(`# ${i.identifier}: Write the changelog`);
    expect(data.prompt).toContain('For **v2**.');
    expect(data.prompt).toContain('Keep it short.');
    expect(data.prompt).toContain('Run the tests before opening a PR.');

    // A runner's own instructions come first, then the agent's; nothing is stored.
    const extra = await issue('With runner instructions', { assigneeId: agentId });
    await agent('PATCH', `${ws}/agent/runs/${data.run.id}`, { status: 'running' });
    await owner.patch(`${ws}/agents/${agentId}`, { concurrency: 2 });
    const withExtra = (await agent('POST', `${ws}/agent/claim`, {
      instructions: 'Use the homelab GPU box.',
    })) as unknown as { data: AgentRunContext };
    expect(withExtra.data.issue.id).toBe(extra.id);
    expect(withExtra.data.agent.instructions).toBe(
      'Use the homelab GPU box.\n\nRun the tests before opening a PR.',
    );
    expect(withExtra.data.prompt).toContain(
      '## Instructions\nUse the homelab GPU box.\n\nRun the tests before opening a PR.',
    );
    await agent('PATCH', `${ws}/agent/runs/${withExtra.data.run.id}`, { status: 'succeeded' });
    await owner.patch(`${ws}/agents/${agentId}`, { concurrency: 1 });

    // One at a time by default.
    await issue('Another', { assigneeId: agentId });
    expect((await claim()).statusCode).toBe(204);

    const beat = await agent('POST', `${ws}/agent/runs/${data.run.id}/heartbeat`);
    expect(beat.data).toMatchObject({ cancelled: false, status: 'running' });
    await agent('PATCH', `${ws}/agent/runs/${data.run.id}`, {
      status: 'running',
      sessionUrl: 'https://claude.ai/code/session-1',
    });
    const done = await agent('PATCH', `${ws}/agent/runs/${data.run.id}`, {
      status: 'succeeded',
      summary: 'Wrote the changelog in CHANGELOG.md.',
    });
    expect(done.data).toMatchObject({
      status: 'succeeded',
      sessionUrl: 'https://claude.ai/code/session-1',
    });
    expect(done.data.startedAt).toBeTruthy();
    expect(done.data.finishedAt).toBeTruthy();
    const comments = (await owner.get(`${ws}/issues/${i.id}/comments`)).data as Comment[];
    expect(comments.at(-1)).toMatchObject({
      authorId: agentId,
      body: 'Wrote the changelog in CHANGELOG.md.',
    });
    // Finished is final.
    expect(
      (await agent('PATCH', `${ws}/agent/runs/${data.run.id}`, { status: 'failed' })).statusCode,
    ).toBe(409);

    // The queued one is next; finish it so the rest of the tests start clean.
    const next = await claim();
    expect(next.data.issue.title).toBe('Another');
    await agent('PATCH', `${ws}/agent/runs/${next.data.run.id}`, {
      status: 'failed',
      error: 'boom',
    });
    const failure = (await owner.get(`${ws}/issues/${next.data.issue.id}/comments`)).data;
    expect(failure.at(-1).body).toContain('This run failed');
    expect(failure.at(-1).body).toContain('boom');
  });

  it('wakes a waiting runner as soon as work arrives', async () => {
    const started = Date.now();
    const waiting = claim(10);
    await new Promise((r) => setTimeout(r, 300));
    const i = await issue('Long poll', { assigneeId: agentId });
    const { statusCode, data } = await waiting;
    expect(statusCode).toBe(200);
    expect(data.issue.id).toBe(i.id);
    expect(Date.now() - started).toBeLessThan(5000);
    await agent('PATCH', `${ws}/agent/runs/${data.run.id}`, { status: 'succeeded' });
  });

  it('hands concurrent claims different runs', async () => {
    await owner.patch(`${ws}/agents/${agentId}`, { concurrency: 3 });
    const a = await issue('Parallel A', { assigneeId: agentId });
    const b = await issue('Parallel B', { assigneeId: agentId });
    const results = await Promise.all([claim(), claim(), claim()]);
    const got = results.filter((r) => r.statusCode === 200).map((r) => r.data.issue.id);
    expect(got.sort()).toEqual([a.id, b.id].sort());
    for (const r of results)
      if (r.statusCode === 200)
        await agent('PATCH', `${ws}/agent/runs/${r.data.run.id}`, { status: 'succeeded' });
    await owner.patch(`${ws}/agents/${agentId}`, { concurrency: 1 });
  });

  it('tells the runner when a person cancels, and stops on unassignment', async () => {
    const i = await issue('Cancel me', { assigneeId: agentId });
    const { data } = await claim();
    const cancelled = await member.post(`${ws}/agent-runs/${data.run.id}/cancel`);
    expect(cancelled.data.status).toBe('cancelled');
    const beat = await agent('POST', `${ws}/agent/runs/${data.run.id}/heartbeat`);
    expect(beat.data).toMatchObject({ cancelled: true });
    expect(
      (await agent('PATCH', `${ws}/agent/runs/${data.run.id}`, { status: 'succeeded' })).statusCode,
    ).toBe(409);

    // Run again queues a fresh run; unassigning cancels it.
    const again = await member.post(`${ws}/issues/${i.id}/agent-runs`);
    expect(again.data.status).toBe('queued');
    await member.patch(`${ws}/issues/${i.id}`, { assigneeId: null });
    expect((await runsOf(i.id)).map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
    expect((await member.post(`${ws}/issues/${i.id}/agent-runs`)).statusCode).toBe(400);
  });

  it('puts runs back when the runner goes quiet, and fails them in the end', async () => {
    const i = await issue('Flaky runner', { assigneeId: agentId });
    const { data } = await claim();
    const lapse = () =>
      app.db
        .update(agentRuns)
        .set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(agentRuns.id, data.run.id));
    await lapse();
    await reapLeases(app);
    expect((await runsOf(i.id))[0]).toMatchObject({ status: 'queued', attempts: 1 });

    for (const attempt of [2, 3]) {
      const again = await claim();
      expect(again.data.run).toMatchObject({ id: data.run.id, attempts: attempt });
      await lapse();
      await reapLeases(app);
    }
    expect((await runsOf(i.id))[0]).toMatchObject({ status: 'failed', attempts: 3 });
    const comments = (await owner.get(`${ws}/issues/${i.id}/comments`)).data as Comment[];
    expect(comments.at(-1)).toMatchObject({ authorId: agentId });
    expect(comments.at(-1)!.body).toContain('failed after 3 attempts');
  });

  it('cancels runs whose issue the agent can no longer see', async () => {
    const i = await issue('Moving away', { assigneeId: agentId });
    // Straight in the database: moving it through the API would unassign it first.
    await app.db.execute(sql`update issues set team_id = ${prv} where id = ${i.id}`);
    expect((await claim()).statusCode).toBe(204);
    expect((await runsOf(i.id))[0]!.status).toBe('cancelled');
  });

  it('records runs for webhooks', async () => {
    const rows = await app.db
      .select({ data: domainEvents.data })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.workspaceId, boot.workspace.id),
          eq(domainEvents.type, 'agent_run.updated'),
        ),
      );
    expect(rows.length).toBeGreaterThan(5);
    const statuses = rows.map((r) => (r.data as { status: string }).status);
    expect(statuses).toEqual(expect.arrayContaining(['queued', 'claimed', 'succeeded', 'failed']));
    expect(rows.every((r) => (r.data as { agentId: string }).agentId === agentId)).toBe(true);
  });

  it('stops working when the agent is disabled', async () => {
    const i = await issue('Last one', { assigneeId: agentId });
    expect((await runsOf(i.id))[0]!.status).toBe('queued');
    await owner.patch(`${ws}/agents/${agentId}`, { disabled: true });
    expect((await runsOf(i.id))[0]!.status).toBe('cancelled');
    expect((await claim()).statusCode).toBe(401);
    // Assigning it now queues nothing.
    const j = await issue('After', { assigneeId: agentId });
    expect(await runsOf(j.id)).toEqual([]);
  });
});

describe('questions', () => {
  let askerId: string;
  let askerKey: string;
  let ownerName: string;
  const as = (method: string, url: string, body?: unknown) => bearer(askerKey, method, url, body);
  const claimAsker = () =>
    as('POST', `${ws}/agent/claim?runner=asker-host`) as Promise<{
      statusCode: number;
      data: AgentRunContext;
    }>;

  beforeAll(async () => {
    ownerName = (await owner.get('/api/auth/me')).data.username;
    askerId = (await owner.post(`${ws}/agents`, { name: 'Asker', teamIds: [eng] })).data.id;
    askerKey = (await owner.post(`${ws}/agents/${askerId}/keys`, { name: 'q' })).data.token;
  });

  it('pause a run until a person replies, and resume it with the thread and the token', async () => {
    const i = await issue('Which API version?', { assigneeId: askerId });
    const first = await claimAsker();
    const runId = first.data.run.id;
    expect(first.data.prompt).toContain('ask_question');

    // A question is required, and only on a run the agent holds.
    expect((await as('PATCH', `${ws}/agent/runs/${runId}`, { status: 'waiting' })).statusCode).toBe(
      400,
    );
    expect(
      (
        await as('PATCH', `${ws}/agent/runs/00000000-0000-4000-8000-000000000000`, {
          status: 'waiting',
          question: 'x',
        })
      ).statusCode,
    ).toBe(404);

    await as('PATCH', `${ws}/agent/runs/${runId}`, { resume: 'session-1' });
    const asked = await as('PATCH', `${ws}/agent/runs/${runId}`, {
      status: 'waiting',
      question: 'Should this target v1 or v2?',
    });
    expect(asked.data).toMatchObject({
      status: 'waiting',
      question: 'Should this target v1 or v2?',
    });
    // Posted by the agent, mentioning who asked for the work, who hears about it.
    const comments = (await owner.get(`${ws}/issues/${i.id}/comments`)).data as Comment[];
    expect(comments.at(-1)).toMatchObject({
      authorId: askerId,
      body: `@${ownerName} Should this target v1 or v2?`,
    });
    const inbox = (await owner.get(`${ws}/notifications`)).data as {
      type: string;
      issueId: string;
    }[];
    expect(inbox).toContainEqual(expect.objectContaining({ type: 'issue_mention', issueId: i.id }));

    // Waiting holds no lease and takes no concurrency: other work goes ahead meanwhile.
    const other = await issue('Meanwhile', { assigneeId: askerId });
    const second = await claimAsker();
    expect(second.data.issue.id).toBe(other.id);
    await as('PATCH', `${ws}/agent/runs/${second.data.run.id}`, { status: 'succeeded' });

    // The runner's late reports change nothing; the heartbeat says why.
    expect((await as('POST', `${ws}/agent/runs/${runId}/heartbeat`)).data).toMatchObject({
      cancelled: false,
      waiting: true,
    });
    expect(
      (await as('PATCH', `${ws}/agent/runs/${runId}`, { status: 'succeeded', summary: 'Asked.' }))
        .data.status,
    ).toBe('waiting');

    // The agent's own comment isn't an answer; a person's is.
    await as('POST', `${ws}/issues/${i.id}/comments`, { body: 'Still waiting.' });
    expect((await runsOf(i.id))[0]!.status).toBe('waiting');
    await member.post(`${ws}/issues/${i.id}/comments`, { body: 'Use v2.' });
    expect((await runsOf(i.id))[0]).toMatchObject({ id: runId, status: 'queued', attempts: 0 });

    const resumed = await claimAsker();
    expect(resumed.data.run).toMatchObject({
      id: runId,
      question: 'Should this target v1 or v2?',
      resume: 'session-1',
      attempts: 1,
    });
    expect(resumed.data.comments.at(-1)!.body).toBe('Use v2.');
    expect(resumed.data.prompt).toContain('## You asked\nShould this target v1 or v2?');

    // Run again resumes without an answer; unassigning stops a waiting run.
    await as('PATCH', `${ws}/agent/runs/${runId}`, {
      status: 'waiting',
      question: 'And the docs?',
    });
    expect((await member.post(`${ws}/issues/${i.id}/agent-runs`)).data).toMatchObject({
      id: runId,
      status: 'queued',
    });
    await claimAsker();
    await as('PATCH', `${ws}/agent/runs/${runId}`, { status: 'waiting', question: 'Still there?' });
    await owner.patch(`${ws}/issues/${i.id}`, { assigneeId: null });
    expect((await runsOf(i.id))[0]!.status).toBe('cancelled');
  });
});

describe('handing an issue to another agent', () => {
  it("keeps the run the agent hands it on from, and cancels only what's left", async () => {
    const triage = (await owner.post(`${ws}/agents`, { name: 'Triager', teamIds: [eng] })).data;
    const coder = (await owner.post(`${ws}/agents`, { name: 'Builder', teamIds: [eng] })).data;
    const triageKey = (await owner.post(`${ws}/agents/${triage.id}/keys`, { name: 't' })).data
      .token;
    const i = await issue('Hand me on', { assigneeId: triage.id });
    const run = (await bearer(triageKey, 'POST', `${ws}/agent/claim`)).data as AgentRunContext;
    expect(run.issue.id).toBe(i.id);

    // The triage agent assigns it onward while still working on it.
    const moved = await bearer(triageKey, 'PATCH', `${ws}/issues/${i.id}`, {
      assigneeId: coder.id,
    });
    expect(moved.statusCode).toBe(200);
    const runs = await runsOf(i.id);
    expect(runs.find((r) => r.agentId === coder.id)?.status).toBe('queued');
    expect(runs.find((r) => r.agentId === triage.id)?.status).toBe('claimed');

    // So its report still lands, summary and all.
    const done = await bearer(triageKey, 'PATCH', `${ws}/agent/runs/${run.run.id}`, {
      status: 'succeeded',
      summary: 'Triaged; over to Builder.',
    });
    expect(done.data.status).toBe('succeeded');
    const comments = (await owner.get(`${ws}/issues/${i.id}/comments`)).data as Comment[];
    expect(comments.at(-1)).toMatchObject({
      authorId: triage.id,
      body: 'Triaged; over to Builder.',
    });

    // A person taking it away still stops the agent that's working on it.
    await owner.patch(`${ws}/issues/${i.id}`, { assigneeId: null });
    expect((await runsOf(i.id)).find((r) => r.agentId === coder.id)?.status).toBe('cancelled');
  });
});

describe('mentions', () => {
  it("ask an agent for help on an issue that isn't its own", async () => {
    const helper = (
      await owner.post(`${ws}/agents`, { name: 'Helper', teamIds: [eng], concurrency: 3 })
    ).data;
    const quiet = (await owner.post(`${ws}/agents`, { name: 'Quiet', teamIds: [eng] })).data;
    const hidden = (await owner.post(`${ws}/agents`, { name: 'Hidden', teamIds: [prv] })).data;
    const helperKey = (await owner.post(`${ws}/agents/${helper.id}/keys`, { name: 'h' })).data
      .token;
    const as = (method: string, url: string, body?: unknown) =>
      bearer(helperKey, method, url, body);
    const i = await issue('Slow dashboard');

    const asked = (
      await member.post(`${ws}/issues/${i.id}/comments`, {
        body: '@helper can you find out why this is slow? @hidden too',
      })
    ).data;
    const runs = await runsOf(i.id);
    // Only agents who can work in the issue's team are asked.
    expect(runs).toEqual([
      expect.objectContaining({
        agentId: helper.id,
        status: 'queued',
        trigger: 'mention',
        triggerCommentId: asked.id,
      }),
    ]);
    expect(runs.some((r) => r.agentId === hidden.id)).toBe(false);

    const first = (await as('POST', `${ws}/agent/claim`)).data as AgentRunContext;
    expect(first.assigned).toBe(false);
    expect(first.trigger).toMatchObject({
      kind: 'mention',
      comment: { id: asked.id, author: 'Max Member' },
    });
    expect(first.prompt).toContain("isn't assigned to you");
    expect(first.prompt).toContain("## Why you're here\nMax Member mentioned you in a comment:");
    expect(first.prompt).toContain('> @helper can you find out why this is slow?');

    // A mention while it's working queues one follow-up, which waits for this run to end.
    await member.post(`${ws}/issues/${i.id}/comments`, { body: '@helper also check the API' });
    await member.post(`${ws}/issues/${i.id}/comments`, { body: '@helper and the database' });
    expect((await runsOf(i.id)).map((r) => r.status)).toEqual(['queued', 'claimed']);
    expect((await as('POST', `${ws}/agent/claim`)).statusCode).toBe(204);
    await as('PATCH', `${ws}/agent/runs/${first.run.id}`, {
      status: 'succeeded',
      summary: 'Found it.',
    });
    const second = (await as('POST', `${ws}/agent/claim`)).data as AgentRunContext;
    expect(second.issue.id).toBe(i.id);
    expect(second.trigger.comment?.body).toBe('@helper also check the API');
    // It sees everything said meanwhile, including the mention that didn't need its own run.
    expect(second.comments.map((c) => c.body)).toEqual(
      expect.arrayContaining(['@helper and the database', 'Found it.']),
    );
    await as('PATCH', `${ws}/agent/runs/${second.run.id}`, { status: 'succeeded' });

    // Agents mentioning agents start nothing (they hand work on by assigning).
    await as('POST', `${ws}/issues/${i.id}/comments`, { body: '@quiet over to you' });
    expect((await runsOf(i.id)).some((r) => r.agentId === quiet.id)).toBe(false);

    // Assigned: the mention is part of its own work, and Run again says so.
    await owner.patch(`${ws}/issues/${i.id}`, { assigneeId: helper.id });
    const third = (await as('POST', `${ws}/agent/claim`)).data as AgentRunContext;
    expect(third).toMatchObject({ assigned: true, trigger: { kind: 'assigned' } });
    expect(third.prompt).toContain('You have been assigned');
    await as('PATCH', `${ws}/agent/runs/${third.run.id}`, { status: 'succeeded' });
    expect((await member.post(`${ws}/issues/${i.id}/agent-runs`)).data.trigger).toBe('rerun');
  });
});

describe('the workspace run list', () => {
  type Listed = AgentRun & { issue: { identifier: string; teamId: string } };
  const list = async (who: Client, query = '') =>
    (await who.get(`${ws}/agent-runs${query}`)).data as Listed[];

  it('lists runs on visible issues, newest change first, filtered by status and agent', async () => {
    const all = await list(owner);
    expect(all.length).toBeGreaterThan(5);
    expect(all[0]!.issue.identifier).toMatch(/^ENG-\d+$/);
    const times = all.map((r) => r.id);
    expect(new Set(times).size).toBe(times.length);

    const active = await list(owner, '?status=active');
    expect(
      active.every((r) => ['queued', 'claimed', 'running', 'waiting'].includes(r.status)),
    ).toBe(true);
    const finished = await list(owner, '?status=finished');
    expect(finished.every((r) => ['succeeded', 'failed', 'cancelled'].includes(r.status))).toBe(
      true,
    );
    expect(active.length + finished.length).toBe(all.length);

    const mine = await list(owner, `?agentId=${agentId}`);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.agentId === agentId)).toBe(true);
    expect((await list(owner, '?limit=2')).length).toBe(2);
    expect((await owner.get(`${ws}/agent-runs?status=nope`)).statusCode).toBe(400);
  });

  it("leaves out runs on issues the caller can't see", async () => {
    // "Moving away" ended up in the private team; a plain member doesn't see it.
    const ownerView = await list(owner);
    const memberView = await list(member);
    expect(ownerView.some((r) => r.issue.teamId === prv)).toBe(true);
    expect(memberView.some((r) => r.issue.teamId === prv)).toBe(false);
    expect(memberView.length).toBe(ownerView.filter((r) => r.issue.teamId !== prv).length);
  });
});
