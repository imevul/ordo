import type { AgentRun, AgentRunContext, Bootstrap } from '@ordo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns, domainEvents } from '../src/db/schema.ts';
import { reapLeases } from '../src/services/agents.ts';
import { wants } from '../src/services/webhooks.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let workspaceId: string;
const slug = `idle-${Date.now()}`;
const ws = `/api/w/${slug}`;
let eng: string;
let ops: string;
let agentId: string;
let key: string;

const agent = (method: string, url: string, body?: unknown) =>
  app.inject({
    method: method as 'GET',
    url: `${ws}${url}`,
    payload: body as object,
    headers: { authorization: `Bearer ${key}` },
  });

const idleEvents = () =>
  app.db
    .select({ data: domainEvents.data, teamIds: domainEvents.teamIds })
    .from(domainEvents)
    .where(and(eq(domainEvents.workspaceId, workspaceId), eq(domainEvents.type, 'agent_runs.idle')))
    .orderBy(asc(domainEvents.id));

/** What the test did since the last call. */
let seen = 0;
const newIdleEvents = async () => {
  const rows = await idleEvents();
  const fresh = rows.slice(seen);
  seen = rows.length;
  return fresh;
};

const queue = async (title: string, teamId = eng) => {
  const issue = (await owner.post(`${ws}/issues`, { teamId, title, assigneeId: agentId })).data;
  return issue.id as string;
};
const claim = async () => {
  const res = await agent('POST', '/agent/claim?wait=0&runner=idle-host');
  expect(res.statusCode).toBe(200);
  return (res.json() as AgentRunContext).run.id;
};
const report = (runId: string, body: unknown) => agent('PATCH', `/agent/runs/${runId}`, body);

beforeAll(async () => {
  app = await testApp();
  owner = (await signup(app, 'Ida Owner')).client;
  await owner.post('/api/workspaces', { name: 'Idle', slug, teamName: 'Eng', teamKey: 'ENG' });
  ops = (await owner.post(`${ws}/teams`, { name: 'Ops', key: 'OPS' })).data.id;
  const boot = (await owner.get(`${ws}/bootstrap`)).data as Bootstrap;
  workspaceId = boot.workspace.id;
  eng = boot.teams.find((t) => t.key === 'ENG')!.id;
  const created = await owner.post(`${ws}/agents`, {
    name: 'Idle Watcher',
    teamIds: [eng, ops],
    concurrency: 3,
  });
  agentId = created.data.id;
  key = (await owner.post(`${ws}/agents/${agentId}/keys`, { name: 'runner' })).data.token;
});
afterAll(() => app.close());

describe('agent_runs.idle', () => {
  it('waits for the last working run to stop', async () => {
    await queue('First');
    await queue('Second');
    const first = await claim();
    const second = await claim();
    expect((await report(first, { status: 'running' })).statusCode).toBe(200);
    expect(await newIdleEvents()).toEqual([]);

    await report(first, { status: 'succeeded' });
    expect(await newIdleEvents()).toEqual([]);

    await report(second, { status: 'failed', error: 'Nope' });
    const events = await newIdleEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ queued: 0, waiting: 0 });
  });

  it('reaches webhooks limited to any team', async () => {
    await queue('In Ops', ops);
    await report(await claim(), { status: 'succeeded' });
    const [event] = await newIdleEvents();
    expect(event!.teamIds.sort()).toEqual([eng, ops].sort());
    expect(
      wants({ eventTypes: ['agent_runs.idle'], teamIds: [eng] }, 'agent_runs.idle', event!.teamIds),
    ).toBe(true);
    expect(
      wants({ eventTypes: ['issue.created'], teamIds: [] }, 'agent_runs.idle', event!.teamIds),
    ).toBe(false);
  });

  it('stays quiet about runs that never worked', async () => {
    const issueId = await queue('Queued only');
    const [run] = (await owner.get(`${ws}/issues/${issueId}/agent-runs`)).data as AgentRun[];
    expect(run!.status).toBe('queued');
    await owner.post(`${ws}/agent-runs/${run!.id}/cancel`);
    expect(await newIdleEvents()).toEqual([]);
  });

  it('counts the runs left open', async () => {
    await queue('Asks');
    const asks = await claim();
    await queue('Queued behind it');
    await report(asks, { status: 'waiting', question: 'Which one?' });
    const events = await newIdleEvents();
    expect(events.map((e) => e.data)).toEqual([{ queued: 1, waiting: 1 }]);
    // Clean up what this left open.
    await owner.post(`${ws}/agent-runs/${asks}/cancel`);
    await report(await claim(), { status: 'succeeded' });
    await newIdleEvents();
  });

  it('notices a working run being cancelled', async () => {
    await queue('Cancelled');
    const run = await claim();
    await owner.post(`${ws}/agent-runs/${run}/cancel`);
    expect(await newIdleEvents()).toHaveLength(1);
  });

  it('notices a runner that stopped responding', async () => {
    await queue('Lapsed');
    const run = await claim();
    await app.db
      .update(agentRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agentRuns.id, run));
    await reapLeases(app);
    const events = await newIdleEvents();
    expect(events.map((e) => e.data)).toEqual([{ queued: 1, waiting: 0 }]);
    await report(await claim(), { status: 'succeeded' });
    await newIdleEvents();
  });

  it('says it once when the last runs stop at the same moment', async () => {
    for (let i = 0; i < 3; i++) await queue(`Together ${i}`);
    const runs = [await claim(), await claim(), await claim()];
    const results = await Promise.all(runs.map((r) => report(r, { status: 'succeeded' })));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await newIdleEvents()).toHaveLength(1);
  });
});
