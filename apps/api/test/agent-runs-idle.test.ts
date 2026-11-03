import type { AgentRun, AgentRunContext, Bootstrap } from '@ordo/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns, agents, domainEvents, users } from '../src/db/schema.ts';
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

/** Until another connection is blocked on a lock this transaction holds. */
const waitForLockWait = async (tx: Pick<FastifyInstance['db'], 'execute'>) => {
  for (let i = 0; i < 200; i++) {
    const rows = await tx.execute<{ blocked: number }>(
      sql`select count(*)::int as blocked from pg_stat_activity where pg_backend_pid() = any(pg_blocking_pids(pid))`,
    );
    if (rows[0]!.blocked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Nothing waited for the lock');
};

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

  it('notices the last working run being deleted with its issue', async () => {
    const issueId = await queue('Purged');
    await claim();
    expect((await owner.del(`${ws}/issues/${issueId}`)).statusCode).toBe(200);
    expect(await newIdleEvents()).toEqual([]);
    expect((await owner.del(`${ws}/issues/${issueId}/purge`)).statusCode).toBe(200);
    expect((await newIdleEvents()).map((e) => e.data)).toEqual([{ queued: 0, waiting: 0 }]);
  });

  it('stays quiet when an issue is purged with no run working on it', async () => {
    const issueId = await queue('Purged while queued');
    await owner.del(`${ws}/issues/${issueId}`);
    expect((await owner.del(`${ws}/issues/${issueId}/purge`)).statusCode).toBe(200);
    expect(await newIdleEvents()).toEqual([]);
  });

  it('notices the last working run being deleted with its team', async () => {
    const doomed = (await owner.post(`${ws}/teams`, { name: 'Doomed', key: 'DOOM' })).data.id;
    await owner.patch(`${ws}/agents/${agentId}`, { teamIds: [eng, ops, doomed] });
    await queue('In a doomed team', doomed);
    await claim();
    expect((await owner.del(`${ws}/teams/${doomed}`)).statusCode).toBe(200);
    const events = await newIdleEvents();
    expect(events.map((e) => e.data)).toEqual([{ queued: 0, waiting: 0 }]);
    expect(events[0]!.teamIds).not.toContain(doomed);
  });

  it("stays quiet when a run is cancelled at claim because the agent can't see the issue", async () => {
    const issueId = await queue('Out of reach', ops);
    await owner.patch(`${ws}/agents/${agentId}`, { teamIds: [eng] });
    const res = await agent('POST', '/agent/claim?wait=0&runner=idle-host');
    expect(res.statusCode).toBe(204);
    const [run] = (await owner.get(`${ws}/issues/${issueId}/agent-runs`)).data as AgentRun[];
    expect(run!.status).toBe('cancelled');
    expect(await newIdleEvents()).toEqual([]);
    await owner.patch(`${ws}/agents/${agentId}`, { teamIds: [eng, ops] });
  });

  it('notices a cancel that had to wait for a claim to commit', async () => {
    const issueId = await queue('Claimed mid-cancel');
    const [run] = (await owner.get(`${ws}/issues/${issueId}/agent-runs`)).data as AgentRun[];
    // Holds a claim open, as `takeRun` does: the row still reads as queued to everyone else.
    let cancel: ReturnType<typeof owner.post> | undefined;
    await app.db.transaction(async (tx) => {
      await tx.update(agentRuns).set({ status: 'claimed' }).where(eq(agentRuns.id, run!.id));
      cancel = owner.post(`${ws}/agent-runs/${run!.id}/cancel`);
      await waitForLockWait(tx);
    });
    expect((await cancel!).statusCode).toBe(200);
    expect(await newIdleEvents()).toHaveLength(1);
  });

  describe('deleting an agent', () => {
    let adminUser: Client;
    beforeAll(async () => {
      adminUser = (await signup(app, 'Ada Instance')).client;
      const { id: adminId } = (await adminUser.get('/api/auth/me')).data;
      await app.db.update(users).set({ isInstanceAdmin: true }).where(eq(users.id, adminId));
    });

    it('notices the last working run being deleted with its agent', async () => {
      const doomed = (await owner.post(`${ws}/agents`, { name: 'Idle Doomed', teamIds: [eng] }))
        .data;
      const doomedKey = (await owner.post(`${ws}/agents/${doomed.id}/keys`, { name: 'runner' }))
        .data.token;
      await owner.post(`${ws}/issues`, { teamId: eng, title: 'Orphaned', assigneeId: doomed.id });
      const claimed = await app.inject({
        method: 'POST',
        url: `${ws}/agent/claim?wait=0&runner=idle-host`,
        headers: { authorization: `Bearer ${doomedKey}` },
      });
      expect(claimed.statusCode).toBe(200);
      await newIdleEvents();

      expect((await adminUser.del(`/api/admin/users/${doomed.id}`)).statusCode).toBe(200);
      await app.jobs.drain();
      expect((await newIdleEvents()).map((e) => e.data)).toEqual([{ queued: 0, waiting: 0 }]);
    });

    it('waits for a claim in flight without deadlocking', async () => {
      const doomed = (await owner.post(`${ws}/agents`, { name: 'Idle Claimant', teamIds: [eng] }))
        .data;
      const issue = (
        await owner.post(`${ws}/issues`, { teamId: eng, title: 'Racing', assigneeId: doomed.id })
      ).data;
      const [run] = (await owner.get(`${ws}/issues/${issue.id}/agent-runs`)).data as AgentRun[];
      await newIdleEvents();

      // Holds a claim open in `takeRun`'s order: the agent's row, then the run.
      let del: ReturnType<typeof adminUser.del> | undefined;
      await app.db.transaction(async (tx) => {
        await tx.select().from(agents).where(eq(agents.userId, doomed.id)).for('update');
        del = adminUser.del(`/api/admin/users/${doomed.id}`);
        await waitForLockWait(tx);
        await tx.update(agentRuns).set({ status: 'claimed' }).where(eq(agentRuns.id, run!.id));
      });
      expect((await del!).statusCode).toBe(200);
      await app.jobs.drain();
      expect((await newIdleEvents()).map((e) => e.data)).toEqual([{ queued: 0, waiting: 0 }]);
    });
  });
});
