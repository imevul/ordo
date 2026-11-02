import type {
  AgentRunContext,
  AgentRunWithIssue,
  Bootstrap,
  Issue,
  IssueFilter,
} from '@ordo/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type Json, signup, testApp } from './helpers.ts';

/**
 * Filtering issues on agent runs: what a run is waiting on, and for whom. Every reason is set up
 * the way it really happens, and checked against what a runner may actually claim.
 */

let app: FastifyInstance;
let owner: Client;
let member: Client;
let memberId: string;
let ownerId: string;
let boot: Bootstrap;
const slug = `arf-${Date.now()}`;
const ws = `/api/w/${slug}`;
let team: string;
let key = 0;

async function bearer(token: string, method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as object,
    headers: { authorization: `Bearer ${token}` },
  });
  let data: Json = null;
  try {
    data = res.json();
  } catch {}
  return Object.assign(res, { data });
}

/** An agent of its own for each case, so one case's runs can't get claimed in another. */
async function newAgent(extra: Record<string, unknown> = {}) {
  const name = `Agent ${++key}`;
  const id = (await owner.post(`${ws}/agents`, { name, teamIds: [team], ...extra })).data
    .id as string;
  const token = (await owner.post(`${ws}/agents/${id}/keys`, { name: 'k' })).data.token as string;
  return {
    id,
    as: (method: string, url: string, body?: unknown) => bearer(token, method, url, body),
    claim: async () => {
      const res = await bearer(token, 'POST', `${ws}/agent/claim?wait=0&runner=host`);
      return res.statusCode === 200 ? (res.data as AgentRunContext) : null;
    },
  };
}
type TestAgent = Awaited<ReturnType<typeof newAgent>>;

const issue = async (title: string, extra: Record<string, unknown> = {}) =>
  (await owner.post(`${ws}/issues`, { teamId: team, title, ...extra })).data as Issue;

const titles = async (filter: IssueFilter, client: Client = owner) => {
  const res = await client.post(`${ws}/issues/query`, { filter });
  expect(res.statusCode, res.body).toBe(200);
  return (res.data as Issue[]).map((i) => i.title).sort();
};

/** Whether `title` is among the issues waiting on `reason`. */
const waitsOn = async (title: string, reason: NonNullable<IssueFilter['agentRunWaitingOn']>[0]) =>
  (await titles({ agentRunWaitingOn: [reason] })).includes(title);

/** Gives `agent` an issue and takes the run, so it's ready to report something. */
async function working(title: string, agent: TestAgent, extra: Record<string, unknown> = {}) {
  const made = await issue(title, { assigneeId: agent.id, ...extra });
  const claimed = await agent.claim();
  expect(claimed?.issue.identifier).toBe(made.identifier);
  return { issue: made, runId: claimed!.run.id };
}

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Ola Owner')).client;
  await owner.post('/api/workspaces', {
    name: 'Run filters',
    slug,
    teamName: 'One',
    teamKey: 'ONE',
  });
  const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0].token;
  member = (await signup(app, 'Mia Member', { inviteToken: invite })).client;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
  team = boot.teams[0]!.id;
  ownerId = boot.members.find((m) => m.name === 'Ola Owner')!.id;
  memberId = (await owner.get(`${ws}/bootstrap`)).data.members.find(
    (m: { name: string }) => m.name === 'Mia Member',
  ).id;
});
afterAll(() => app.close());

describe('what a run waits on a person for', () => {
  it('a question, and it stops once answered', async () => {
    const agent = await newAgent();
    const { issue: asked, runId } = await working('asked', agent);
    expect(await waitsOn('asked', 'question')).toBe(false);
    await agent.as('PATCH', `${ws}/agent/runs/${runId}`, { status: 'waiting', question: 'v1?' });
    expect(await waitsOn('asked', 'question')).toBe(true);
    expect(await waitsOn('asked', 'person')).toBe(true);
    expect(await waitsOn('asked', 'permission')).toBe(false);
    expect(await titles({ agentRunWaiting: true })).toContain('asked');

    await owner.post(`${ws}/issues/${asked.id}/comments`, { body: 'v2' });
    expect(await waitsOn('asked', 'question')).toBe(false);
    // It's back in the queue: still waiting, on a runner now.
    expect(await waitsOn('asked', 'runner')).toBe(true);
  });

  it('a plan until it is approved', async () => {
    const agent = await newAgent();
    const { runId } = await working('planned', agent);
    await agent.as('PATCH', `${ws}/agent/runs/${runId}`, { status: 'waiting', plan: 'Do it' });
    expect(await waitsOn('planned', 'plan')).toBe(true);
    expect(await waitsOn('planned', 'question')).toBe(false);
    expect((await owner.post(`${ws}/agent-runs/${runId}/approve`)).statusCode).toBe(200);
    expect(await waitsOn('planned', 'plan')).toBe(false);
  });

  it('a permission issue, asked or failed on', async () => {
    const asker = await newAgent();
    const asked = await working('needs access', asker);
    const res = await asker.as('PATCH', `${ws}/agent/runs/${asked.runId}`, {
      status: 'waiting',
      question: 'No push access to acme/api',
      questionKind: 'permission',
    });
    expect(res.data.questionKind).toBe('permission');
    expect(await waitsOn('needs access', 'permission')).toBe(true);
    expect(await waitsOn('needs access', 'question')).toBe(false);
    expect(await waitsOn('needs access', 'person')).toBe(true);

    const failer = await newAgent();
    const failed = await working('denied', failer);
    await failer.as('PATCH', `${ws}/agent/runs/${failed.runId}`, {
      status: 'failed',
      error: 'git push: Permission denied (publickey)',
    });
    expect(await waitsOn('denied', 'permission')).toBe(true);
    expect(await waitsOn('denied', 'failure')).toBe(false);
    expect(await titles({ agentRunFailureReasons: ['permission'] })).toContain('denied');
  });

  it('a question defaults to a decision, through the old protocol', async () => {
    const agent = await newAgent();
    const { runId } = await working('plain question', agent);
    const res = await agent.as('PATCH', `${ws}/agent/runs/${runId}`, {
      status: 'waiting',
      question: 'Which one?',
    });
    expect(res.data.questionKind).toBe('decision');
  });

  it('a failure, until someone deals with it', async () => {
    const agent = await newAgent();
    const { runId } = await working('broke', agent);
    await agent.as('PATCH', `${ws}/agent/runs/${runId}`, { status: 'failed', error: 'boom' });
    expect(await waitsOn('broke', 'failure')).toBe(true);
    expect(await titles({ agentRunWaiting: true })).toContain('broke');
    await owner.post(`${ws}/agent-runs/${runId}/dismiss`);
    expect(await waitsOn('broke', 'failure')).toBe(false);
    expect(await titles({ agentRunWaiting: true })).not.toContain('broke');
  });

  it('stops counting a failure once it was restarted and worked', async () => {
    const agent = await newAgent();
    const { runId } = await working('restarted', agent);
    await agent.as('PATCH', `${ws}/agent/runs/${runId}`, { status: 'failed', error: 'boom' });
    expect(await titles({ agentRunStatuses: ['failed'] })).toContain('restarted');
    expect((await owner.post(`${ws}/agent-runs/${runId}/restart`)).statusCode).toBe(200);
    const again = await agent.claim();
    await agent.as('PATCH', `${ws}/agent/runs/${again!.run.id}`, { status: 'succeeded' });
    expect(await titles({ agentRunStatuses: ['failed'] })).not.toContain('restarted');
    expect(await titles({ agentRunStatuses: ['succeeded'] })).toContain('restarted');
    expect(await waitsOn('restarted', 'failure')).toBe(false);
    expect(await titles({ agentRunAgentIds: [agent.id] })).toEqual(['restarted']);
  });

  it('a usage limit waits for its reset rather than a person', async () => {
    const agent = await newAgent();
    const { runId } = await working('limited', agent);
    await agent.as('PATCH', `${ws}/agent/runs/${runId}`, {
      status: 'failed',
      error: "You've hit your session limit · resets in 2 hours",
    });
    expect(await waitsOn('limited', 'limit_reset')).toBe(true);
    expect(await waitsOn('limited', 'person')).toBe(false);
    expect(await titles({ agentRunWaiting: true })).toContain('limited');
    // Its agent paused too, which holds whatever else it has queued.
    await issue('queued behind the limit', { assigneeId: agent.id });
    expect(await waitsOn('queued behind the limit', 'agent_paused')).toBe(true);
    expect(await waitsOn('queued behind the limit', 'runner')).toBe(false);
    expect(await agent.claim()).toBeNull();
  });
});

describe('whose decision it is', () => {
  it('is whoever asked for the run, else the issue’s creator', async () => {
    const agent = await newAgent();
    // Ola creates and assigns it, so Ola asked. Mia re-running it means Mia asked.
    const mine = await working('asks owner', agent);
    await agent.as('PATCH', `${ws}/agent/runs/${mine.runId}`, {
      status: 'waiting',
      question: 'Ola?',
    });
    expect(await titles({ agentRunWaitingFor: ['me'] })).toContain('asks owner');
    expect(await titles({ agentRunWaitingFor: ['me'] }, member)).not.toContain('asks owner');
    expect(await titles({ agentRunWaitingFor: [ownerId] }, member)).toContain('asks owner');

    const other = await newAgent();
    const theirs = (
      await member.post(`${ws}/issues`, {
        teamId: team,
        title: 'asks member',
        assigneeId: other.id,
      })
    ).data as Issue;
    const claimed = await other.claim();
    expect(claimed?.issue.identifier).toBe(theirs.identifier);
    await other.as('PATCH', `${ws}/agent/runs/${claimed!.run.id}`, {
      status: 'waiting',
      question: 'Mia?',
    });
    expect(await titles({ agentRunWaitingFor: ['me'] }, member)).toContain('asks member');
    expect(await titles({ agentRunWaitingFor: [memberId] })).toContain('asks member');
    expect(await titles({ agentRunWaitingFor: ['me'] })).not.toContain('asks member');
  });

  it('only counts when a person has to act', async () => {
    const agent = await newAgent();
    await issue('just queued', { assigneeId: agent.id });
    expect(await waitsOn('just queued', 'runner')).toBe(true);
    expect(await titles({ agentRunWaitingFor: ['me'] })).not.toContain('just queued');
  });
});

describe('what holds a queued run back', () => {
  it('a blocker, and a runner can’t claim it', async () => {
    const agent = await newAgent();
    const blocker = await issue('in the way');
    const blocked = await issue('behind it');
    await owner.post(`${ws}/issues/${blocked.id}/relations`, {
      type: 'blocked_by',
      relatedIssueId: blocker.id,
    });
    await owner.patch(`${ws}/issues/${blocked.id}`, { assigneeId: agent.id });
    expect(await waitsOn('behind it', 'blocker')).toBe(true);
    expect(await waitsOn('behind it', 'runner')).toBe(false);
    expect(await agent.claim()).toBeNull();

    const done = boot.teams[0]!.states.find((s) => s.type === 'completed')!.id;
    await owner.patch(`${ws}/issues/${blocker.id}`, { stateId: done });
    expect(await waitsOn('behind it', 'blocker')).toBe(false);
    expect(await waitsOn('behind it', 'runner')).toBe(true);
    expect((await agent.claim())?.issue.identifier).toBe(blocked.identifier);
  });

  it('a cycle that hasn’t opened', async () => {
    const cycled = (await owner.post(`${ws}/teams`, { name: 'Cycled', key: 'CYC' })).data.id;
    await owner.patch(`${ws}/teams/${cycled}`, { cyclesEnabled: true });
    const next = (
      await owner.post(`${ws}/teams/${cycled}/cycles`, {
        startsAt: '2099-01-01',
        endsAt: '2099-01-14',
      })
    ).data;
    const name = `Agent ${++key}`;
    const id = (await owner.post(`${ws}/agents`, { name, teamIds: [cycled] })).data.id as string;
    const token = (await owner.post(`${ws}/agents/${id}/keys`, { name: 'k' })).data.token;
    await owner.post(`${ws}/issues`, {
      teamId: cycled,
      title: 'next cycle',
      cycleId: next.id,
      assigneeId: id,
    });
    expect(await waitsOn('next cycle', 'cycle')).toBe(true);
    expect(await waitsOn('next cycle', 'runner')).toBe(false);
    expect((await bearer(token, 'POST', `${ws}/agent/claim?wait=0`)).statusCode).toBe(204);
  });

  it('a repository at its limit', async () => {
    const limited = (await owner.post(`${ws}/teams`, { name: 'Limited', key: 'LTD' })).data.id;
    const repo = (
      await owner.post(`${ws}/repositories`, {
        name: 'mono',
        url: 'https://git.example.com/acme/mono.git',
        maxConcurrentRuns: 1,
      })
    ).data;
    await owner.patch(`${ws}/teams/${limited}`, { defaultRepositoryId: repo.id });
    const make = async () => {
      const id = (await owner.post(`${ws}/agents`, { name: `Agent ${++key}`, teamIds: [limited] }))
        .data.id as string;
      const token = (await owner.post(`${ws}/agents/${id}/keys`, { name: 'k' })).data.token;
      return { id, token: token as string };
    };
    const [first, second] = [await make(), await make()];
    await owner.post(`${ws}/issues`, { teamId: limited, title: 'in repo', assigneeId: first.id });
    expect((await bearer(first.token, 'POST', `${ws}/agent/claim?wait=0`)).statusCode).toBe(200);
    await owner.post(`${ws}/issues`, {
      teamId: limited,
      title: 'repo full',
      assigneeId: second.id,
    });
    expect(await waitsOn('repo full', 'repository')).toBe(true);
    expect(await waitsOn('repo full', 'runner')).toBe(false);
    expect((await bearer(second.token, 'POST', `${ws}/agent/claim?wait=0`)).statusCode).toBe(204);
  });

  it('an agent at capacity, or already on the issue', async () => {
    const agent = await newAgent({ concurrency: 1 });
    await working('busy one', agent);
    await issue('busy two', { assigneeId: agent.id });
    expect(await waitsOn('busy two', 'agent_busy')).toBe(true);
    expect(await waitsOn('busy two', 'runner')).toBe(false);
    expect(await agent.claim()).toBeNull();
  });

  it('the workspace’s pause', async () => {
    const paused = `arf-paused-${Date.now()}`;
    await owner.post('/api/workspaces', {
      name: 'Paused',
      slug: paused,
      teamName: 'P',
      teamKey: 'PAU',
    });
    const at = `/api/w/${paused}`;
    const pausedTeam = (await owner.get(`${at}/bootstrap`)).data.teams[0].id;
    const id = (await owner.post(`${at}/agents`, { name: 'Pausee', teamIds: [pausedTeam] })).data
      .id;
    const token = (await owner.post(`${at}/agents/${id}/keys`, { name: 'k' })).data.token;
    await owner.post(`${at}/issues`, { teamId: pausedTeam, title: 'on hold', assigneeId: id });
    await owner.patch(`${at}/`, { settings: { agentRunsPaused: true } });
    const query = async (filter: IssueFilter) =>
      ((await owner.post(`${at}/issues/query`, { filter })).data as Issue[]).map((i) => i.title);
    expect(await query({ agentRunWaitingOn: ['runs_paused'] })).toEqual(['on hold']);
    expect(await query({ agentRunWaitingOn: ['runner'] })).toEqual([]);
    expect((await bearer(token, 'POST', `${at}/agent/claim?wait=0`)).statusCode).toBe(204);
  });

  it('nothing but a runner, which can claim it', async () => {
    const agent = await newAgent();
    const made = await issue('free to go', { assigneeId: agent.id });
    expect(await waitsOn('free to go', 'runner')).toBe(true);
    expect((await agent.claim())?.issue.identifier).toBe(made.identifier);
    expect(await titles({ agentRunWaiting: true })).not.toContain('free to go');
  });
});

describe('combining run conditions', () => {
  let first: TestAgent;
  let second: TestAgent;

  beforeAll(async () => {
    first = await newAgent();
    second = await newAgent();
    // The same issue: the first agent succeeds on it, the second fails.
    const shared = await working('two agents', first);
    await first.as('PATCH', `${ws}/agent/runs/${shared.runId}`, { status: 'succeeded' });
    await owner.post(`${ws}/issues/${shared.issue.id}/comments`, {
      body: `@${(await owner.get(`${ws}/bootstrap`)).data.members.find((m: { id: string }) => m.id === second.id).username} please`,
    });
    const claimed = await second.claim();
    expect(claimed?.issue.identifier).toBe(shared.issue.identifier);
    await second.as('PATCH', `${ws}/agent/runs/${claimed!.run.id}`, {
      status: 'failed',
      error: 'boom',
    });
    await issue('no agent at all');
  });

  it('holds conditions in one set to the same run', async () => {
    expect(await titles({ agentRunAgentIds: [second.id], agentRunStatuses: ['failed'] })).toEqual([
      'two agents',
    ]);
    expect(await titles({ agentRunAgentIds: [first.id], agentRunStatuses: ['failed'] })).toEqual(
      [],
    );
  });

  it('reads "is not" on the same run when the set names one', async () => {
    expect(
      await titles({
        agentRunAgentIds: [first.id],
        exclude: { agentRunStatuses: ['failed'] },
      }),
    ).toEqual(['two agents']);
    expect(
      await titles({
        agentRunAgentIds: [second.id],
        exclude: { agentRunStatuses: ['failed'] },
      }),
    ).toEqual([]);
  });

  it('reads "is not" over every current run when nothing names one', async () => {
    const notFailed = await titles({ exclude: { agentRunStatuses: ['failed'] } });
    expect(notFailed).not.toContain('two agents');
    expect(notFailed).toContain('no agent at all');
  });

  it('negates the waiting flag, and treats no runs as not waiting', async () => {
    const quiet = await titles({ agentRunWaiting: false });
    expect(quiet).toContain('no agent at all');
    expect(quiet).not.toContain('two agents');
    expect(await titles({ exclude: { agentRunWaiting: true } })).toEqual(quiet);
  });

  it('keeps "or" groups apart', async () => {
    const found = await titles({
      or: [
        { agentRunAgentIds: [first.id], agentRunStatuses: ['failed'] },
        { agentRunAgentIds: [second.id], agentRunStatuses: ['failed'] },
      ],
    });
    expect(found).toEqual(['two agents']);
  });

  it('finds issues with and without any run', async () => {
    expect(await titles({ hasAgentRun: false })).toContain('no agent at all');
    expect(await titles({ hasAgentRun: true })).not.toContain('no agent at all');
    expect(await titles({ exclude: { hasAgentRun: true } })).toContain('no agent at all');
  });

  it('filters on trigger and when the run last did something', async () => {
    expect(await titles({ agentRunAgentIds: [second.id], agentRunTriggers: ['mention'] })).toEqual([
      'two agents',
    ]);
    expect(await titles({ agentRunAgentIds: [second.id], agentRunTriggers: ['rerun'] })).toEqual(
      [],
    );
    expect(await titles({ agentRunAgentIds: [second.id], agentRunAt: { range: 'today' } })).toEqual(
      ['two agents'],
    );
    expect(
      await titles({ agentRunAgentIds: [second.id], agentRunAt: { to: '2000-01-01' } }),
    ).toEqual([]);
  });

  it('takes one current run when two start in one transaction', async () => {
    const agent = await newAgent();
    const { issue: tied, runId } = await working('tied', agent);
    await agent.as('PATCH', `${ws}/agent/runs/${runId}`, { status: 'failed', error: 'boom' });
    // A second run with the first one's very timestamp, as two inserts in one transaction get.
    await app.db.execute(sql`
      insert into agent_runs (workspace_id, issue_id, agent_id, status, created_at)
      select workspace_id, issue_id, agent_id, 'succeeded', created_at from agent_runs where id = ${runId}`);
    const failed = await titles({ agentRunAgentIds: [agent.id], agentRunStatuses: ['failed'] });
    const done = await titles({ agentRunAgentIds: [agent.id], agentRunStatuses: ['succeeded'] });
    expect([failed, done].flat()).toEqual([tied.title]);
  });
});

describe('access', () => {
  it('doesn’t reach another team’s issues', async () => {
    const hidden = (await owner.post(`${ws}/teams`, { name: 'Hidden', key: 'HID', private: true }))
      .data.id;
    const id = (await owner.post(`${ws}/agents`, { name: `Agent ${++key}`, teamIds: [hidden] }))
      .data.id;
    await owner.post(`${ws}/issues`, { teamId: hidden, title: 'secret', assigneeId: id });
    expect(await titles({ agentRunWaiting: true })).toContain('secret');
    expect(await titles({ agentRunWaiting: true }, member)).not.toContain('secret');
    expect(await titles({ agentRunAgentIds: [id] }, member)).toEqual([]);
  });
});

describe('the run list', () => {
  let slowpoke: TestAgent;
  let listed: { blocked: string; asked: string; failed: string; restarted: string };

  const query = async (body: Record<string, unknown> = {}, client: Client = owner) => {
    const res = await client.post(`${ws}/agent-runs/query`, {
      filter: { agentRunAgentIds: [slowpoke.id] },
      group: 'all',
      ...body,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.data as { runs: AgentRunWithIssue[]; hasMore: boolean };
  };
  const reasons = async (id: string) =>
    (await owner.get(`${ws}/agent-runs/${id}`)).data as AgentRunWithIssue;

  beforeAll(async () => {
    slowpoke = await newAgent({ concurrency: 5 });
    const asked = await working('list: asked', slowpoke);
    await slowpoke.as('PATCH', `${ws}/agent/runs/${asked.runId}`, {
      status: 'waiting',
      question: 'Which?',
      questionKind: 'permission',
    });
    const failed = await working('list: failed', slowpoke);
    await slowpoke.as('PATCH', `${ws}/agent/runs/${failed.runId}`, {
      status: 'failed',
      error: 'boom',
    });
    const restarted = await working('list: restarted', slowpoke);
    await slowpoke.as('PATCH', `${ws}/agent/runs/${restarted.runId}`, {
      status: 'failed',
      error: 'boom',
    });
    await owner.post(`${ws}/agent-runs/${restarted.runId}/restart`);
    const again = await slowpoke.claim();
    await slowpoke.as('PATCH', `${ws}/agent/runs/${again!.run.id}`, { status: 'succeeded' });
    const blocker = await issue('list: blocker');
    const blockedIssue = await issue('list: blocked');
    await owner.post(`${ws}/issues/${blockedIssue.id}/relations`, {
      type: 'blocked_by',
      relatedIssueId: blocker.id,
    });
    await owner.patch(`${ws}/issues/${blockedIssue.id}`, { assigneeId: slowpoke.id });
    const blocked = (
      await query({ filter: { agentRunAgentIds: [slowpoke.id], agentRunStatuses: ['queued'] } })
    ).runs[0]!;
    listed = {
      blocked: blocked.id,
      asked: asked.runId,
      failed: failed.runId,
      restarted: restarted.runId,
    };
  });

  it('lists what is waiting and why, and whom it needs', async () => {
    const { runs } = await query({ group: 'waiting' });
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(listed.asked)!.waitReasons).toEqual(['permission']);
    expect(byId.get(listed.asked)!.waitingForId).toBe(ownerId);
    expect(byId.get(listed.failed)!.waitReasons).toEqual(['failure']);
    expect(byId.get(listed.blocked)!.waitReasons).toEqual(['blocker']);
    expect(byId.get(listed.blocked)!.waitingForId).toBeNull();
    // Restarted and done: nothing left to do about it.
    expect(byId.has(listed.restarted)).toBe(false);
    expect(runs.every((r) => r.waitReasons.length > 0)).toBe(true);
    expect((await reasons(listed.asked)).waitReasons).toEqual(['permission']);
  });

  it('applies run conditions to the run in the row, not the issue’s newest', async () => {
    const failed = await query({
      filter: { agentRunAgentIds: [slowpoke.id], agentRunStatuses: ['failed'] },
    });
    expect(failed.runs.map((r) => r.id).sort()).toEqual([listed.failed, listed.restarted].sort());
    // What needs a person doesn't count a run someone already restarted.
    const person = await query({
      filter: { agentRunAgentIds: [slowpoke.id], agentRunWaitingOn: ['person'] },
    });
    expect(person.runs.map((r) => r.id).sort()).toEqual([listed.asked, listed.failed].sort());
    const blocked = await query({
      filter: { agentRunAgentIds: [slowpoke.id], agentRunWaitingOn: ['blocker'] },
    });
    expect(blocked.runs.map((r) => r.id)).toEqual([listed.blocked]);
    const notFailed = await query({
      filter: { agentRunAgentIds: [slowpoke.id], exclude: { agentRunStatuses: ['failed'] } },
    });
    expect(notFailed.runs.map((r) => r.id)).not.toContain(listed.failed);
    expect(notFailed.runs.map((r) => r.id)).toContain(listed.asked);
    const mine = await query({
      filter: { agentRunAgentIds: [slowpoke.id], agentRunWaitingFor: ['me'] },
    });
    expect(mine.runs.map((r) => r.id).sort()).toEqual([listed.asked, listed.failed].sort());
  });

  it('also filters on the run’s issue', async () => {
    const priority = (await issue('list: urgent', { assigneeId: slowpoke.id, priority: 1 })).id;
    const urgent = await query({ filter: { agentRunAgentIds: [slowpoke.id], priorities: [1] } });
    expect(urgent.runs.map((r) => r.issue.id)).toEqual([priority]);
  });

  it('pages through runs without repeats', async () => {
    const first = await query({ limit: 2 });
    expect(first.runs).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const seen = new Set(first.runs.map((r) => r.id));
    let offset = 2;
    for (;;) {
      const page = await query({ limit: 2, offset });
      for (const r of page.runs) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      offset += 2;
      if (!page.hasMore) break;
    }
    expect(seen.size).toBe((await query({ limit: 200 })).runs.length);
  });

  it('keeps runs on trashed issues listed', async () => {
    const agent = await newAgent();
    const trashed = await working('list: trashed', agent);
    await agent.as('PATCH', `${ws}/agent/runs/${trashed.runId}`, { status: 'succeeded' });
    await owner.del(`${ws}/issues/${trashed.issue.id}`);
    const { runs } = await query({ filter: { agentRunAgentIds: [agent.id] } });
    expect(runs.map((r) => r.id)).toEqual([trashed.runId]);
  });

  it('refuses what makes no sense for a run', async () => {
    for (const filter of [
      { q: 'words' },
      { trashed: true },
      { subscribedBy: 'me' },
      { hasAgentRun: true },
      { or: [{ hasAgentRun: true }] },
      { nonsense: 1 },
    ]) {
      const res = await owner.post(`${ws}/agent-runs/query`, { filter });
      expect(res.statusCode, JSON.stringify(filter)).toBe(400);
    }
  });

  it('stays within the caller’s teams', async () => {
    const hidden = (await owner.post(`${ws}/teams`, { name: 'Vault', key: 'VLT', private: true }))
      .data.id;
    const id = (await owner.post(`${ws}/agents`, { name: `Agent ${++key}`, teamIds: [hidden] }))
      .data.id;
    await owner.post(`${ws}/issues`, { teamId: hidden, title: 'vaulted', assigneeId: id });
    const see = async (client: Client, body: Record<string, unknown>) =>
      ((await client.post(`${ws}/agent-runs/query`, body)).data.runs as AgentRunWithIssue[]).map(
        (r) => r.issue.title,
      );
    const filter = { agentRunAgentIds: [id] };
    expect(await see(owner, { filter, group: 'waiting' })).toEqual(['vaulted']);
    expect(await see(owner, { filter, group: 'waiting', teamId: hidden })).toEqual(['vaulted']);
    expect(await see(owner, { filter, group: 'waiting', teamId: team })).toEqual([]);
    expect(await see(member, { filter, group: 'waiting' })).toEqual([]);
    expect(
      await see(member, { group: 'all', filter: { or: [{ agentRunAgentIds: [id] }] } }),
    ).toEqual([]);
    const refused = await member.post(`${ws}/agent-runs/query`, { teamId: hidden });
    expect([403, 404]).toContain(refused.statusCode);
  });

  it('answers on GET too', async () => {
    const res = await owner.get(`${ws}/agent-runs?status=waiting&agentId=${slowpoke.id}`);
    expect(res.statusCode).toBe(200);
    expect((res.data as AgentRunWithIssue[]).map((r) => r.id)).toContain(listed.asked);
  });
});

describe('saved views of runs', () => {
  const view = (body: Record<string, unknown>, client: Client = owner) =>
    client.post(`${ws}/views`, { name: 'Waiting', filters: {}, ...body });

  it('default to issues, so API clients keep working', async () => {
    const res = await view({ name: 'Plain' });
    expect(res.data.kind).toBe('issues');
  });

  it('keep what they list, and come back with the workspace', async () => {
    const res = await view({
      name: 'Waiting for me',
      kind: 'agentRuns',
      filters: { agentRunWaitingFor: ['me'] },
      display: { agentRunGroup: 'waiting' },
      teamId: team,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.data).toMatchObject({
      kind: 'agentRuns',
      filters: { agentRunWaitingFor: ['me'] },
      teamId: team,
    });
    expect(res.data.display.agentRunGroup).toBe('waiting');
    const listed = (await owner.get(`${ws}/bootstrap`)).data.views.find(
      (v: { id: string }) => v.id === res.data.id,
    );
    expect(listed.kind).toBe('agentRuns');

    const changed = await owner.patch(`${ws}/views/${res.data.id}`, {
      filters: { agentRunWaitingOn: ['person'] },
      teamId: null,
      display: { agentRunGroup: 'all' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.data).toMatchObject({ kind: 'agentRuns', teamId: null });
    expect(changed.data.display.agentRunGroup).toBe('all');
    // What it lists is fixed: `kind` isn't something an update changes.
    const again = await owner.patch(`${ws}/views/${res.data.id}`, { kind: 'issues' });
    expect(again.data.kind).toBe('agentRuns');
  });

  it('refuse what makes no sense for a run', async () => {
    for (const filters of [{ q: 'words' }, { trashed: true }, { hasAgentRun: true }]) {
      const res = await view({ kind: 'agentRuns', filters });
      expect(res.statusCode, JSON.stringify(filters)).toBe(400);
    }
    const made = await view({ kind: 'agentRuns' });
    const res = await owner.patch(`${ws}/views/${made.data.id}`, { filters: { q: 'words' } });
    expect(res.statusCode).toBe(400);
    // Issue views still take them.
    expect((await view({ filters: { q: 'words' } })).statusCode).toBe(200);
  });

  it('stay private when asked, and can’t name a team you can’t see', async () => {
    const mine = await view({ name: 'Just mine', kind: 'agentRuns', shared: false });
    const others = (await member.get(`${ws}/bootstrap`)).data.views as { id: string }[];
    expect(others.some((v) => v.id === mine.data.id)).toBe(false);
    const hidden = (await owner.post(`${ws}/teams`, { name: 'Sealed', key: 'SLD', private: true }))
      .data.id;
    const made = await view({ kind: 'agentRuns' }, member);
    expect(made.statusCode).toBe(200);
    const moved = await member.patch(`${ws}/views/${made.data.id}`, { teamId: hidden });
    expect([403, 404]).toContain(moved.statusCode);
  });

  it('can’t feed a calendar', async () => {
    const made = await view({ kind: 'agentRuns' });
    const res = await owner.post(`${ws}/calendar-feeds`, { viewId: made.data.id });
    expect(res.statusCode).toBe(400);
    const plain = await view({});
    expect((await owner.post(`${ws}/calendar-feeds`, { viewId: plain.data.id })).statusCode).toBe(
      200,
    );
  });
});
