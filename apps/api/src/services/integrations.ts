import { randomUUID } from 'node:crypto';
import { AVATAR_COLORS, type Integration, type IntegrationProviderInfo } from '@ordo/shared';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { domainEvents, integrationApps, integrations, users } from '../db/schema.ts';
import { getProvider, listProviders } from '../integrations/registry.ts';
import type {
  InboundRequest,
  IntegrationContext,
  IntegrationProvider,
  IntegrationRow,
  Secrets,
} from '../integrations/types.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { notFound, one } from '../lib/errors.ts';
import { enqueue, type JobContext } from '../lib/jobs/index.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import { auditCtx } from './audit.ts';
import type { Ctx } from './context.ts';
import type { EventRow } from './events.ts';
import { toPayloads } from './events.ts';
import { integrationAppSecretsAad, integrationSecretsAad } from './secretKey.ts';

/**
 * Integrations: per-workspace connections to outside services. Providers (in `integrations/`)
 * plug into three paths, each a job so a slow or failing service never blocks a request:
 * inbound webhooks (`integration.inbound`), domain events (`integration.event`) and polling
 * (`integration.poll`). Changes an integration makes are attributed to its bot account and carry
 * `source: integration:<id>`, so it never receives its own echoes.
 */

export function readSecrets(app: FastifyInstance, row: IntegrationRow): Secrets {
  return row.secrets
    ? JSON.parse(app.keyring.decrypt(row.secrets, integrationSecretsAad(row.id)))
    : {};
}

type AppRow = typeof integrationApps.$inferSelect;

export function readAppSecrets(app: FastifyInstance, row: AppRow): Secrets {
  return row.secrets
    ? JSON.parse(app.keyring.decrypt(row.secrets, integrationAppSecretsAad(row.id)))
    : {};
}

export const sealAppSecrets = (app: FastifyInstance, id: string, secrets: Secrets) =>
  app.keyring.encrypt(JSON.stringify(secrets), integrationAppSecretsAad(id));

/** An integration's secrets, plus its app's (e.g. the GitHub App's webhook secret and key). */
export async function allSecrets(app: FastifyInstance, row: IntegrationRow): Promise<Secrets> {
  if (!row.appId) return readSecrets(app, row);
  const [appRow] = await app.db
    .select()
    .from(integrationApps)
    .where(eq(integrationApps.id, row.appId));
  return { ...(appRow ? readAppSecrets(app, appRow) : {}), ...readSecrets(app, row) };
}

export function sealSecrets(app: FastifyInstance, id: string, secrets: Secrets) {
  return Object.keys(secrets).length
    ? app.keyring.encrypt(JSON.stringify(secrets), integrationSecretsAad(id))
    : null;
}

export const providerInfo = (p: IntegrationProvider): IntegrationProviderInfo => ({
  key: p.key,
  name: p.name,
  description: p.description,
  category: p.category,
});

export const listProviderInfo = () => listProviders().map(providerInfo);

export function toIntegration(app: FastifyInstance, row: IntegrationRow): Integration {
  const provider = getProvider(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    lastError: row.lastError,
    lastEventAt: row.lastEventAt,
    config: row.config,
    // App-based integrations share their app's webhook URL instead.
    inboundUrl:
      provider?.handleInbound && !row.appId && !provider.wantsConnection?.(row)
        ? `${app.env.publicUrl}/api/hooks/${row.provider}/${row.inboundToken}`
        : null,
    createdAt: row.createdAt,
  };
}

export function integrationContext(
  app: FastifyInstance,
  row: IntegrationRow,
  log: FastifyBaseLogger = app.log,
): IntegrationContext {
  return {
    app,
    integration: row,
    secrets: readSecrets(app, row),
    log: log.child({ integration: row.id, provider: row.provider }),
    run: (fn) =>
      runInWorkspace(
        app,
        {
          workspaceId: row.workspaceId,
          actorId: row.botUserId ?? row.createdById!,
          source: `integration:${row.id}`,
        },
        fn,
      ),
    saveState: async (patch) => {
      await app.db
        .update(integrations)
        .set({ state: sql`${integrations.state} || ${JSON.stringify(patch)}::jsonb` })
        .where(eq(integrations.id, row.id));
    },
  };
}

/** Creates the integration and its bot account in the caller's transaction. */
export async function createIntegration(
  app: FastifyInstance,
  ctx: Ctx,
  input: {
    provider: IntegrationProvider;
    name?: string;
    config: Record<string, unknown>;
    secrets: Secrets;
    appId?: string | null;
    externalId?: string | null;
  },
) {
  const id = randomUUID();
  const short = id.slice(0, 8);
  const bot = one(
    await ctx.tx
      .insert(users)
      .values({
        kind: 'bot',
        botWorkspaceId: ctx.workspaceId,
        email: `bot-${id}@bots.ordo.invalid`,
        name: input.name || input.provider.name,
        username: `${input.provider.key}-bot-${short}`,
        passwordHash: null,
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
      })
      .returning({ id: users.id }),
  );
  const row = one(
    await ctx.tx
      .insert(integrations)
      .values({
        id,
        workspaceId: ctx.workspaceId,
        provider: input.provider.key,
        appId: input.appId ?? null,
        name: input.name || input.provider.name,
        config: input.config,
        secrets: sealSecrets(app, id, input.secrets),
        botUserId: bot.id,
        inboundToken: randomToken(24),
        externalId: input.externalId ?? null,
        createdById: ctx.userId,
      })
      .returning(),
  );
  await auditCtx(ctx, {
    action: 'integration.created',
    targetType: 'integration',
    targetId: id,
    data: { provider: input.provider.key, name: row.name },
  });
  return row;
}

export async function loadIntegration(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)));
  if (!row) throw notFound('Integration');
  return row;
}

/** Runs a provider hook, keeping the integration's status and last error current. */
export async function track(app: FastifyInstance, row: IntegrationRow, fn: () => Promise<void>) {
  try {
    await fn();
    await app.db
      .update(integrations)
      .set({
        lastEventAt: new Date().toISOString(),
        ...(row.status === 'error' && { status: 'active', lastError: null }),
      })
      .where(eq(integrations.id, row.id));
  } catch (err) {
    await app.db
      .update(integrations)
      .set({
        status: 'error',
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      })
      // An admin may have switched it off meanwhile; that wins.
      .where(and(eq(integrations.id, row.id), ne(integrations.status, 'disabled')));
    throw err;
  }
}

export async function activeIntegration(app: FastifyInstance, id: string) {
  const [row] = await app.db.select().from(integrations).where(eq(integrations.id, id));
  if (!row || row.status === 'disabled') return null;
  const provider = getProvider(row.provider);
  return provider ? { row, provider } : null;
}

// ─── the three paths in ───────────────────────────────────────────────────

/** Called by the event dispatcher: one ordered job per integration and event. */
export async function dispatchToIntegrations(
  app: FastifyInstance,
  workspaceId: string,
  events: EventRow[],
) {
  const rows = await app.db
    .select({ id: integrations.id, provider: integrations.provider })
    .from(integrations)
    .where(
      and(
        eq(integrations.workspaceId, workspaceId),
        or(eq(integrations.status, 'active'), eq(integrations.status, 'error')),
      ),
    );
  const interested = rows.filter((r) => getProvider(r.provider)?.onDomainEvent);
  if (!interested.length) return;
  await app.db.transaction(async (tx) => {
    for (const integration of interested) {
      for (const event of events) {
        if (event.source === `integration:${integration.id}`) continue;
        await enqueue(
          tx,
          'integration.event',
          { integrationId: integration.id, eventId: event.id },
          {
            orderingKey: `integration:${integration.id}`,
            dedupeKey: `ie:${integration.id}:${event.id}`,
            once: true,
          },
        );
      }
    }
  });
}

export async function runIntegrationEvent(
  app: FastifyInstance,
  { integrationId, eventId }: { integrationId: string; eventId: number },
  job: JobContext,
) {
  const found = await activeIntegration(app, integrationId);
  if (!found?.provider.onDomainEvent) return;
  const [event] = await app.db.select().from(domainEvents).where(eq(domainEvents.id, eventId));
  if (!event) return;
  const [payload] = await toPayloads(app, [event]);
  const ictx = integrationContext(app, found.row, job.log);
  await track(app, found.row, () =>
    found.provider.onDomainEvent!(ictx, { ...payload!, teamIds: event.teamIds }),
  );
}

/** Queues an inbound delivery (from a webhook or a long-lived connection), once per delivery id. */
export async function queueInbound(
  app: FastifyInstance,
  provider: IntegrationProvider,
  row: IntegrationRow,
  req: InboundRequest,
) {
  const deliveryId = provider.deliveryId?.(req) ?? sha256(req.body);
  await enqueue(
    app.db,
    'integration.inbound',
    { integrationId: row.id, req },
    { dedupeKey: `in:${row.id}:${deliveryId}`, orderingKey: `integration:${row.id}` },
  );
}

export async function runInbound(
  app: FastifyInstance,
  { integrationId, req }: { integrationId: string; req: InboundRequest },
  job: JobContext,
) {
  const found = await activeIntegration(app, integrationId);
  if (!found?.provider.handleInbound) return;
  const ictx = integrationContext(app, found.row, job.log);
  await track(app, found.row, () => found.provider.handleInbound!(ictx, req));
}

/** Scheduled every minute: queues a poll for each integration whose interval has passed. */
export async function schedulePolls(app: FastifyInstance) {
  const pollers = listProviders().filter((p) => p.poll);
  if (!pollers.length) return;
  const rows = await app.db
    .select()
    .from(integrations)
    .where(
      and(
        inArray(
          integrations.provider,
          pollers.map((p) => p.key),
        ),
        or(eq(integrations.status, 'active'), eq(integrations.status, 'error')),
      ),
    );
  const now = Date.now();
  for (const row of rows) {
    const interval = (getProvider(row.provider)?.pollIntervalSeconds ?? 300) * 1000;
    if (row.lastPolledAt && now - new Date(row.lastPolledAt).getTime() < interval) continue;
    await enqueue(
      app.db,
      'integration.poll',
      { integrationId: row.id },
      {
        orderingKey: `integration:${row.id}`,
        dedupeKey: `poll:${row.id}:${Math.floor(now / interval)}`,
        maxAttempts: 1,
      },
    );
  }
}

export async function runPoll(
  app: FastifyInstance,
  { integrationId }: { integrationId: string },
  job: JobContext,
) {
  const found = await activeIntegration(app, integrationId);
  if (!found?.provider.poll) return;
  await app.db
    .update(integrations)
    .set({ lastPolledAt: new Date().toISOString() })
    .where(eq(integrations.id, integrationId));
  const ictx = integrationContext(app, found.row, job.log);
  await track(app, found.row, () => found.provider.poll!(ictx));
}

/**
 * Bot accounts of a workspace, including those of removed integrations: they aren't members, but
 * their names belong next to what they did. Removed ones are disabled and flagged as such.
 */
export async function workspaceBots(db: DbOrTx, workspaceId: string) {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      avatarColor: users.avatarColor,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(and(eq(users.botWorkspaceId, workspaceId), eq(users.kind, 'bot')));
  return rows.map(({ disabledAt, ...b }) => ({ ...b, removed: !!disabledAt }));
}
