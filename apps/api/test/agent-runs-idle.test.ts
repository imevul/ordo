import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AGENT_RUN_OPEN,
  type AgentRun,
  type AgentRunContext,
  type Bootstrap,
  type WebhookPayload,
} from '@ordo/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentRuns,
  agents,
  domainEvents,
  integrations,
  users,
  webhookDeliveries,
} from '../src/db/schema.ts';
import { registerProvider, unregisterProvider } from '../src/integrations/registry.ts';
import { reapLeases } from '../src/services/agents.ts';
import { dispatchEvents } from '../src/services/events.ts';
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
  app = await testApp({ settingsFromEnv: { allowPrivateNetworkTargets: true } });
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

  it('belongs to the team that went quiet', async () => {
    await queue('In Ops', ops);
    await report(await claim(), { status: 'succeeded' });
    const [event] = await newIdleEvents();
    expect(event!.teamIds).toEqual([ops]);
    expect(
      wants({ eventTypes: ['agent_runs.idle'], teamIds: [ops] }, 'agent_runs.idle', event!.teamIds),
    ).toBe(true);
    expect(
      wants({ eventTypes: ['agent_runs.idle'], teamIds: [eng] }, 'agent_runs.idle', event!.teamIds),
    ).toBe(false);
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

describe('agent_runs.idle deliveries', () => {
  let sec: string;
  let quiet: string;
  const hookIds: Record<string, string> = {};
  let received: { name: string; payload: WebhookPayload }[] = [];
  let server: Server;

  /** What each webhook got since the last call, by name. */
  const deliveries = async () => {
    await app.jobs.drain();
    const got = received;
    received = [];
    return Object.fromEntries(
      Object.keys(hookIds).map((name) => [
        name,
        got.filter((r) => r.name === name).map((r) => r.payload.data),
      ]),
    );
  };
  const none = { eng: [], engOps: [], engSec: [], sec: [], empty: [], all: [] };
  const clearRuns = () =>
    app.db
      .update(agentRuns)
      .set({ status: 'cancelled' })
      .where(
        and(eq(agentRuns.workspaceId, workspaceId), inArray(agentRuns.status, [...AGENT_RUN_OPEN])),
      );

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({ name: req.url!.slice(1), payload: JSON.parse(body) });
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    sec = (await owner.post(`${ws}/teams`, { name: 'Sec', key: 'SEC', private: true })).data.id;
    quiet = (await owner.post(`${ws}/teams`, { name: 'Quiet', key: 'QUI' })).data.id;
    await owner.patch(`${ws}/agents/${agentId}`, { teamIds: [eng, ops, sec, quiet] });
    const limits = {
      eng: [eng],
      engOps: [eng, ops],
      engSec: [eng, sec],
      sec: [sec],
      empty: [quiet],
      all: [],
    };
    for (const [name, teamIds] of Object.entries(limits)) {
      const hook = await owner.post(`${ws}/webhooks`, {
        url: `${base}/${name}`,
        eventTypes: ['agent_runs.idle'],
        teamIds,
      });
      expect(hook.statusCode).toBe(200);
      hookIds[name] = hook.data.webhook.id;
    }
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('fires for the team that went quiet, with what each webhook can see', async () => {
    // Ops and Sec each have a run waiting, then everything below is queued behind a working one.
    await queue('Ops asks', ops);
    await report(await claim(), { status: 'waiting', question: 'Which one?' });
    await queue('Sec asks', sec);
    await report(await claim(), { status: 'waiting', question: 'Which one?' });
    await deliveries();

    await queue('Eng works', eng);
    const working = await claim();
    await queue('Eng queued', eng);
    for (let i = 0; i < 2; i++) await queue(`Ops queued ${i}`, ops);
    for (let i = 0; i < 3; i++) await queue(`Sec queued ${i}`, sec);
    await report(working, { status: 'succeeded' });

    expect(await deliveries()).toEqual({
      ...none,
      eng: [{ queued: 1, waiting: 0 }],
      engOps: [{ queued: 3, waiting: 1 }],
      engSec: [{ queued: 4, waiting: 1 }],
      all: [{ queued: 6, waiting: 2 }],
    });
  });

  it('keeps other teams out of what it stores and resends', async () => {
    const stored = await app.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hookIds.eng!))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(1);
    const text = JSON.stringify(stored[0]!.payload);
    expect(text).not.toContain(sec);
    expect(text).not.toContain(ops);
    expect(text).not.toContain('teamCounts');
    expect(stored[0]!.payload.data).toEqual({ queued: 1, waiting: 0 });

    const again = await owner.post(
      `${ws}/webhooks/${hookIds.eng}/deliveries/${stored[0]!.id}/redeliver`,
    );
    expect(again.statusCode).toBe(200);
    expect((await deliveries()).eng).toEqual([{ queued: 1, waiting: 0 }]);
  });

  it('counts the same however late or often the dispatch runs', async () => {
    const [event] = await app.db
      .select()
      .from(domainEvents)
      .where(
        and(eq(domainEvents.workspaceId, workspaceId), eq(domainEvents.type, 'agent_runs.idle')),
      )
      .orderBy(desc(domainEvents.id))
      .limit(1);
    await dispatchEvents(app, { workspaceId, ids: [event!.id] });
    expect(await deliveries()).toEqual(none);
  });

  it('stays quiet for a webhook while another of its teams is working', async () => {
    await clearRuns();
    await queue('Eng works', eng);
    await queue('Ops works', ops);
    await queue('Sec works', sec);
    const engRun = await claim();
    const opsRun = await claim();
    const secRun = await claim();
    await deliveries();

    await report(opsRun, { status: 'succeeded' });
    // Ops went quiet, but the only webhook with Ops also has Eng, which is still working.
    expect(await deliveries()).toEqual(none);

    await report(engRun, { status: 'succeeded' });
    const afterEng = await deliveries();
    expect(afterEng.eng).toHaveLength(1);
    expect(afterEng.engOps).toHaveLength(1);
    // Sec is still working, so these wait.
    expect(afterEng.engSec).toEqual([]);
    expect(afterEng.sec).toEqual([]);
    expect(afterEng.all).toEqual([]);

    await report(secRun, { status: 'succeeded' });
    const afterSec = await deliveries();
    expect(afterSec.eng).toEqual([]);
    expect(afterSec.engOps).toEqual([]);
    expect(afterSec.engSec).toHaveLength(1);
    expect(afterSec.sec).toHaveLength(1);
    expect(afterSec.all).toHaveLength(1);
    expect(afterSec.empty).toEqual([]);
  });

  it('hears a team going quiet when an issue working there moves away', async () => {
    await clearRuns();
    const issueId = await queue('Moving', eng);
    const run = await claim();
    await deliveries();

    const moved = await owner.patch(`${ws}/issues/${issueId}`, { teamId: quiet });
    expect(moved.statusCode).toBe(200);
    const heard = await deliveries();
    expect(heard.eng).toHaveLength(1);
    // Still working, in its new team.
    expect(heard.all).toEqual([]);
    expect(heard.empty).toEqual([]);

    await report(run, { status: 'succeeded' });
    const after = await deliveries();
    expect(after.empty).toHaveLength(1);
    expect(after.all).toHaveLength(1);
    expect(after.eng).toEqual([]);
  });

  it('tells integrations only about the whole workspace', async () => {
    await clearRuns();
    await queue('In Eng', eng);
    await queue('In Ops', ops);
    const first = await claim();
    const second = await claim();
    await report(first, { status: 'succeeded' });
    await report(second, { status: 'succeeded' });
    await deliveries();
    const events = await app.db
      .select()
      .from(domainEvents)
      .where(
        and(eq(domainEvents.workspaceId, workspaceId), eq(domainEvents.type, 'agent_runs.idle')),
      )
      .orderBy(desc(domainEvents.id))
      .limit(2);
    const [wholeWorkspace, oneTeam] = events;
    expect(oneTeam!.teamCounts).not.toBeNull();
    expect(Object.values(oneTeam!.teamCounts!).some((c) => c.working > 0)).toBe(true);
    expect(Object.values(wholeWorkspace!.teamCounts!).some((c) => c.working > 0)).toBe(false);

    const heard: unknown[] = [];
    registerProvider({
      key: 'idle-fake',
      name: 'Idle fake',
      description: 'A test provider',
      category: 'other',
      configure: ({ config }) => ({ config, secrets: {} }),
      onDomainEvent: async (_ictx, event) => {
        if (event.type === 'agent_runs.idle') heard.push(event.data);
      },
    });
    try {
      const connected = await owner.post(`${ws}/integrations`, { provider: 'idle-fake' });
      expect(connected.statusCode).toBe(200);
      await dispatchEvents(app, { workspaceId, ids: [oneTeam!.id, wholeWorkspace!.id] });
      await app.jobs.drain();
      expect(heard).toEqual([wholeWorkspace!.data]);
    } finally {
      await app.db.delete(integrations).where(eq(integrations.provider, 'idle-fake'));
      unregisterProvider('idle-fake');
    }
  });
});
