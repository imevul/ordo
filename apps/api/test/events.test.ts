import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bootstrap, IssueDetail, WebhookPayload } from '@ordo/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, domainEvents, integrations, issues, users, webhooks } from '../src/db/schema.ts';
import { registerProvider, unregisterProvider } from '../src/integrations/registry.ts';
import type { IntegrationEvent } from '../src/integrations/types.ts';
import { runInWorkspace } from '../src/lib/mutate.ts';
import { createIssue } from '../src/services/issues.ts';
import { upsertIssueLink } from '../src/services/links.ts';
import { type Client, signup, testApp } from './helpers.ts';

let app: FastifyInstance;
let owner: Client;
let ownerId: string;
let boot: Bootstrap;
const slug = `ev-${Date.now()}`;
const ws = `/api/w/${slug}`;
const teamA = () => boot.teams[0]!;
let teamB: { id: string };

// ─── a webhook receiver ─────────────────────────────────────────────────

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  payload: WebhookPayload;
}
let server: Server;
let receiverUrl: string;
let received: Received[] = [];
let respondWith = 200;

/** Runs every queued job, including retries that are waiting on backoff. */
async function settle(rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    await app.db.execute(sql`update jobs set run_at = now() where status = 'pending'`);
    await app.jobs.drain();
  }
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body, payload: JSON.parse(body) });
    res.writeHead(respondWith).end(respondWith === 200 ? 'thanks' : 'nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

  app = await testApp({
    settingsFromEnv: { signupMode: 'open', allowPrivateNetworkTargets: true },
  });
  owner = (await signup(app, 'Eve Owner')).client;
  ownerId = (await owner.get('/api/auth/me')).data.id;
  await owner.post('/api/workspaces', { name: 'Events', slug, teamName: 'Alpha', teamKey: 'ALP' });
  teamB = (await owner.post(`${ws}/teams`, { name: 'Beta', key: 'BET' })).data;
  boot = (await owner.get(`${ws}/bootstrap`)).data;
});
afterAll(async () => {
  await app.close();
  await new Promise((r) => server.close(r));
});

const eventCount = async () =>
  Number(
    (
      await app.db
        .select({ n: count() })
        .from(domainEvents)
        .where(eq(domainEvents.workspaceId, boot.workspace.id))
    )[0]!.n,
  );

describe('outbox', () => {
  it('records events in the same transaction as the change', async () => {
    const before = await eventCount();
    const issue = (await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'Outbox' })).data;
    await owner.patch(`${ws}/issues/${issue.id}`, { title: 'Outbox!' });
    const rows = await app.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.workspaceId, boot.workspace.id));
    expect(rows.length).toBe(before + 2);
    const [created, updated] = rows.slice(-2);
    expect(created).toMatchObject({ type: 'issue.created', source: 'web', actorId: ownerId });
    expect(created!.data.identifier).toBe(issue.identifier);
    expect(updated!.changes).toEqual([{ field: 'title', from: 'Outbox', to: 'Outbox!' }]);
  });

  it('leaves nothing behind when the transaction rolls back, and nothing for silent work', async () => {
    const before = await eventCount();
    await expect(
      runInWorkspace(
        app,
        { workspaceId: boot.workspace.id, actorId: ownerId, source: 'system' },
        async (ctx) => {
          await createIssue(ctx, { teamId: teamA().id, title: 'Doomed' });
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    await runInWorkspace(
      app,
      { workspaceId: boot.workspace.id, actorId: ownerId, source: 'import', silent: true },
      (ctx) => createIssue(ctx, { teamId: teamA().id, title: 'Imported' }),
    );
    expect(await eventCount()).toBe(before);
    const [{ n }] = (await app.db
      .select({ n: count() })
      .from(issues)
      .where(eq(issues.title, 'Doomed'))) as [{ n: number }];
    expect(Number(n)).toBe(0);
  });
});

describe('webhooks', () => {
  let hookId: string;
  let secret: string;

  it('is admin-only and shows the secret only on request', async () => {
    await settle(); // events from before the webhook existed
    const created = await owner.post(`${ws}/webhooks`, { url: receiverUrl, description: 'all' });
    expect(created.statusCode).toBe(200);
    hookId = created.data.webhook.id;
    secret = created.data.secret;
    expect(secret).toMatch(/^whsec_/);
    const list = await owner.get(`${ws}/webhooks`);
    expect(JSON.stringify(list.data)).not.toContain(secret);
    expect((await owner.get(`${ws}/webhooks/${hookId}/secret`)).data.secret).toBe(secret);

    const invite = (await owner.post(`${ws}/invites`, { role: 'member' })).data[0];
    const member = (await signup(app, 'Mo Member', { inviteToken: invite.token })).client;
    expect((await member.get(`${ws}/webhooks`)).statusCode).toBe(403);
    expect((await owner.post(`${ws}/webhooks`, { url: 'ftp://example.com' })).statusCode).toBe(400);
  });

  it('delivers signed events in commit order', async () => {
    received = [];
    const issue = (await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'Hooked' })).data;
    await owner.patch(`${ws}/issues/${issue.id}`, { priority: 1 });
    await owner.post(`${ws}/issues/${issue.id}/comments`, { body: 'Looks good' });
    await settle();
    expect(received.map((r) => r.payload.type)).toEqual([
      'issue.created',
      'issue.updated',
      'comment.created',
    ]);
    const [first] = received;
    expect(first!.payload.workspace.slug).toBe(slug);
    expect(first!.payload.actor?.id).toBe(ownerId);
    expect(first!.headers['ordo-event']).toBe('issue.created');
    // Verify the signature the way a receiver would.
    const [t, v1] = String(first!.headers['ordo-signature'])
      .split(',')
      .map((p) => p.split('=')[1]!);
    const expected = createHmac('sha256', secret).update(`${t}.${first!.body}`).digest('hex');
    expect(timingSafeEqual(Buffer.from(v1!), Buffer.from(expected))).toBe(true);
    expect(received[1]!.payload.changes).toEqual([{ field: 'priority', from: 0, to: 1 }]);

    const deliveries = (await owner.get(`${ws}/webhooks/${hookId}/deliveries`)).data;
    expect(deliveries[0]).toMatchObject({ status: 'success', responseStatus: 200, attempts: 1 });
  });

  it('applies event and team filters', async () => {
    await owner.patch(`${ws}/webhooks/${hookId}`, {
      eventTypes: ['comment.created'],
      teamIds: [teamB.id],
    });
    received = [];
    const inA = (await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'A' })).data;
    await owner.post(`${ws}/issues/${inA.id}/comments`, { body: 'in A' });
    const inB = (await owner.post(`${ws}/issues`, { teamId: teamB.id, title: 'B' })).data;
    await owner.post(`${ws}/issues/${inB.id}/comments`, { body: 'in B' });
    await settle();
    expect(
      received.map((r) => [r.payload.type, (r.payload.data.comment as { body: string }).body]),
    ).toEqual([['comment.created', 'in B']]);
    await owner.patch(`${ws}/webhooks/${hookId}`, { eventTypes: [], teamIds: [] });
  });

  it('pings, redelivers, retries and gives up', async () => {
    received = [];
    await owner.post(`${ws}/webhooks/${hookId}/ping`);
    await settle();
    expect(received[0]!.payload.type).toBe('ping');

    respondWith = 500;
    received = [];
    await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'Failing' });
    await settle();
    let [latest] = (await owner.get(`${ws}/webhooks/${hookId}/deliveries`)).data;
    expect(latest).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 500 });
    await settle(9);
    [latest] = (await owner.get(`${ws}/webhooks/${hookId}/deliveries`)).data;
    expect(latest).toMatchObject({ status: 'failed', attempts: 10 });
    expect(received).toHaveLength(10);
    expect((await owner.get(`${ws}/webhooks`)).data[0].failureCount).toBe(1);

    respondWith = 200;
    received = [];
    await owner.post(`${ws}/webhooks/${hookId}/deliveries/${latest.id}/redeliver`);
    await settle();
    expect(received[0]!.payload.id).toBe(latest.eventId);
    expect((await owner.get(`${ws}/webhooks`)).data[0].failureCount).toBe(0);
  });

  it('switches itself off after many failed deliveries', async () => {
    await app.db.update(webhooks).set({ failureCount: 19 }).where(eq(webhooks.id, hookId));
    respondWith = 500;
    await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'Last straw' });
    await settle(10);
    respondWith = 200;
    const [hook] = (await owner.get(`${ws}/webhooks`)).data;
    expect(hook).toMatchObject({ enabled: false, failureCount: 20 });
    expect(hook.disabledReason).toContain('20 failed deliveries');
    const audits = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'webhook.disabled'), eq(auditLog.targetId, hookId)));
    expect(audits).toHaveLength(1);
    // Turning it back on resets the count.
    expect((await owner.patch(`${ws}/webhooks/${hookId}`, { enabled: true })).data).toMatchObject({
      enabled: true,
      failureCount: 0,
      disabledReason: null,
    });
  });
});

describe('integration framework', () => {
  const seen: IntegrationEvent[] = [];
  let failNext = false;
  /** Outbound events about the issue with this title fail. */
  let rejecting: string | null = null;
  let integrationId: string;
  let inboundUrl: string;

  beforeAll(() => {
    registerProvider({
      key: 'fake',
      name: 'Fake',
      description: 'A test provider',
      category: 'other',
      configure: ({ config, secrets }) => {
        if (typeof secrets.token !== 'string' || !secrets.token) throw new Error('token required');
        return { config, secrets: { token: secrets.token } };
      },
      verify: (req, _row, secrets) => req.headers['x-fake-token'] === secrets.token,
      deliveryId: (req) => req.headers['x-fake-delivery'] ?? null,
      handleInbound: async (ictx, req) => {
        if (failNext) {
          failNext = false;
          throw new Error('remote said no');
        }
        const body = JSON.parse(req.body) as { title: string; url: string };
        await ictx.run(async (ctx) => {
          const issue = await createIssue(ctx, {
            teamId: ictx.integration.config.teamId as string,
            title: body.title,
          });
          await upsertIssueLink(ctx, {
            issueId: issue.id,
            provider: 'fake',
            kind: 'pull_request',
            externalId: body.url,
            url: body.url,
            title: body.title,
            state: 'open',
            integrationId: ictx.integration.id,
          });
        });
      },
      onDomainEvent: async (_ictx, event) => {
        if (rejecting && (event.data as { title?: string }).title === rejecting)
          throw new Error('remote rejected the update');
        seen.push(event);
      },
    });
  });
  afterAll(() => unregisterProvider('fake'));

  const hook = (body: object, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: new URL(inboundUrl).pathname,
      payload: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('connects with a bot account and an inbound URL', async () => {
    expect(
      (await owner.post(`${ws}/integrations`, { provider: 'fake', secrets: {} })).statusCode,
    ).toBe(400);
    const res = await owner.post(`${ws}/integrations`, {
      provider: 'fake',
      config: { teamId: teamA().id },
      secrets: { token: 'let-me-in' },
    });
    expect(res.statusCode).toBe(200);
    integrationId = res.data.id;
    inboundUrl = res.data.inboundUrl;
    expect(inboundUrl).toMatch(/\/api\/hooks\/fake\//);
    expect(JSON.stringify(res.data)).not.toContain('let-me-in');
    const [row] = await app.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, integrationId));
    const [bot] = await app.db.select().from(users).where(eq(users.id, row!.botUserId!));
    expect(bot!.kind).toBe('bot');
    const fresh: Bootstrap = (await owner.get(`${ws}/bootstrap`)).data;
    expect(fresh.bots).toMatchObject([{ id: bot!.id, removed: false }]);
    expect(fresh.members.map((m) => m.id)).not.toContain(bot!.id);
  });

  it('verifies, deduplicates and processes inbound webhooks as the bot', async () => {
    const pr = { title: 'Fix the flux capacitor', url: 'https://code.example/pr/1' };
    expect((await hook(pr, { 'x-fake-token': 'wrong', 'x-fake-delivery': 'd1' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/hooks/fake/nope',
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await hook(pr, { 'x-fake-token': 'let-me-in', 'x-fake-delivery': 'd1' })).statusCode,
    ).toBe(202);
    expect(
      (await hook(pr, { 'x-fake-token': 'let-me-in', 'x-fake-delivery': 'd1' })).statusCode,
    ).toBe(202);
    await settle();
    const created = await app.db.select().from(issues).where(eq(issues.title, pr.title));
    expect(created).toHaveLength(1);
    const [row] = await app.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, integrationId));
    expect(created[0]!.creatorId).toBe(row!.botUserId);

    const detail: IssueDetail = (await owner.get(`${ws}/issues/${created[0]!.id}`)).data;
    expect(detail.links).toMatchObject([
      { provider: 'fake', kind: 'pull_request', url: pr.url, state: 'open' },
    ]);
  });

  it('sends domain events to integrations, except their own', async () => {
    seen.length = 0;
    await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'Human made' });
    await hook(
      { title: 'Bot made', url: 'https://code.example/pr/2' },
      { 'x-fake-token': 'let-me-in', 'x-fake-delivery': 'd2' },
    );
    await settle(2);
    const titles = seen.map((e) => (e.data as { title?: string }).title);
    expect(titles).toContain('Human made');
    expect(titles).not.toContain('Bot made');
    expect(
      seen.find((e) => (e.data as { title?: string }).title === 'Human made')!.teamIds,
    ).toEqual([teamA().id]);
  });

  it('tracks errors and recovers', async () => {
    failNext = true;
    await hook(
      { title: 'x', url: 'https://code.example/pr/3' },
      { 'x-fake-token': 'let-me-in', 'x-fake-delivery': 'd3' },
    );
    await settle();
    let [listed] = (await owner.get(`${ws}/integrations`)).data.integrations;
    expect(listed).toMatchObject({ status: 'error', lastError: 'remote said no' });
    await settle();
    [listed] = (await owner.get(`${ws}/integrations`)).data.integrations;
    expect(listed).toMatchObject({ status: 'active', lastError: null });
  });

  it("doesn't let a failing outbound event hold up inbound work or other issues", async () => {
    await settle();
    seen.length = 0;
    rejecting = 'Rejected outbound';
    await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'Rejected outbound' });
    await app.jobs.drain();
    const stuck = async () => [
      ...(await app.db.execute<{ status: string; attempts: number }>(
        sql`select status, attempts from jobs where name = 'integration.event'
            and payload->>'integrationId' = ${integrationId} and status <> 'done'`,
      )),
    ];
    // Its first attempt failed; the retry waits on backoff.
    expect(await stuck()).toEqual([{ status: 'pending', attempts: 1 }]);

    const pr = { title: 'Arrived while stuck', url: 'https://code.example/pr/4' };
    await hook(pr, { 'x-fake-token': 'let-me-in', 'x-fake-delivery': 'd4' });
    await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'Unrelated issue' });
    // No `settle()`: only jobs that are due run, so the failed event is still waiting.
    await app.jobs.drain();
    expect(await app.db.select().from(issues).where(eq(issues.title, pr.title))).toHaveLength(1);
    expect(seen.map((e) => (e.data as { title?: string }).title)).toContain('Unrelated issue');
    expect(await stuck()).toEqual([{ status: 'pending', attempts: 1 }]);

    rejecting = null;
    await settle();
    expect(await stuck()).toEqual([]);
    expect(seen.map((e) => (e.data as { title?: string }).title)).toContain('Rejected outbound');
  });

  it('stops accepting hooks when switched off', async () => {
    await owner.patch(`${ws}/integrations/${integrationId}`, { enabled: false });
    expect((await hook({}, { 'x-fake-token': 'let-me-in' })).statusCode).toBe(404);
    await owner.patch(`${ws}/integrations/${integrationId}`, { enabled: true });
  });

  it('keeps the bot, marked as removed, after disconnecting', async () => {
    const [row] = await app.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, integrationId));
    expect((await owner.del(`${ws}/integrations/${integrationId}`)).statusCode).toBe(200);
    const fresh: Bootstrap = (await owner.get(`${ws}/bootstrap`)).data;
    expect(fresh.bots.find((b) => b.id === row!.botUserId)).toMatchObject({
      name: 'Fake',
      removed: true,
    });
    const [bot] = await app.db.select().from(users).where(eq(users.id, row!.botUserId!));
    expect(bot!.disabledAt).not.toBeNull();
  });

  it('lets people attach and remove plain links', async () => {
    const issue = (await owner.post(`${ws}/issues`, { teamId: teamA().id, title: 'Linked' })).data;
    const link = (
      await owner.post(`${ws}/issues/${issue.id}/links`, { url: 'https://docs.example/spec' })
    ).data;
    expect(link).toMatchObject({ provider: 'web', kind: 'link', title: 'docs.example/spec' });
    let detail: IssueDetail = (await owner.get(`${ws}/issues/${issue.id}`)).data;
    expect(detail.links).toHaveLength(1);
    await owner.del(`${ws}/issue-links/${link.id}`);
    detail = (await owner.get(`${ws}/issues/${issue.id}`)).data;
    expect(detail.links).toEqual([]);
  });
});
