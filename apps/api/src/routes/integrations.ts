import { createIssueLinkSchema } from '@ordo/shared';
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { externalAccounts, integrations, users } from '../db/schema.ts';
import { getProvider } from '../integrations/registry.ts';
import type { IntegrationProvider, IntegrationRow } from '../integrations/types.ts';
import { requireAccess, requireAdmin, requireUser, requireWorkspace } from '../lib/auth.ts';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { canReadTeam } from '../services/access.ts';
import { auditCtx } from '../services/audit.ts';
import { chatServices, createLinkCode } from '../services/chat.ts';
import {
  createIntegration,
  integrationContext,
  listProviderInfo,
  loadIntegration,
  readSecrets,
  sealSecrets,
  toIntegration,
} from '../services/integrations.ts';
import { getIssue } from '../services/issues.ts';
import { deleteIssueLink, upsertIssueLink } from '../services/links.ts';

const createSchema = z.object({
  provider: z.string().min(1),
  name: z.string().trim().max(80).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.unknown()).default({}),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Merged into the stored secrets; empty strings are ignored. */
  secrets: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

/** Provider validation errors are the admin's to fix: 400, with the provider's message. */
function configureOrReject(
  provider: IntegrationProvider,
  input: { config: Record<string, unknown>; secrets: Record<string, unknown> },
) {
  try {
    return provider.configure!(input);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : String(err));
  }
}

/** Runs the provider's install step; a failure keeps the integration but shows why it isn't working. */
async function installOrFlag(
  app: FastifyInstance,
  provider: IntegrationProvider,
  row: IntegrationRow,
) {
  try {
    await provider.install!(integrationContext(app, row));
    const [fresh] = await app.db
      .update(integrations)
      .set({ status: 'active', lastError: null })
      .where(eq(integrations.id, row.id))
      .returning();
    return fresh!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [fresh] = await app.db
      .update(integrations)
      .set({ status: 'error', lastError: message })
      .where(eq(integrations.id, row.id))
      .returning();
    return fresh!;
  }
}

export async function integrationRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/integrations', async (req) => {
    const ws = requireAdmin(req);
    const rows = await db
      .select()
      .from(integrations)
      .where(eq(integrations.workspaceId, ws.id))
      .orderBy(desc(integrations.createdAt));
    return { providers: listProviderInfo(), integrations: rows.map((r) => toIntegration(app, r)) };
  });

  /** Connecting by hand (tokens pasted by an admin). OAuth-style providers have their own routes. */
  app.post('/integrations', async (req) => {
    requireAdmin(req);
    if (!app.keyring.available)
      throw badRequest('Set ORDO_SECRET_KEY before connecting integrations');
    const input = parse(createSchema, req.body);
    const provider = getProvider(input.provider);
    if (!provider?.configure) throw badRequest(`Unknown integration: ${input.provider}`);
    const { config, secrets } = configureOrReject(provider, input);
    const row = await mutate(app, req, (ctx) =>
      createIntegration(app, ctx, { provider, name: input.name, config, secrets }),
    );
    return toIntegration(app, provider.install ? await installOrFlag(app, provider, row) : row);
  });

  app.patch('/integrations/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const input = parse(updateSchema, req.body);
    const saved = await mutate(app, req, async (ctx) => {
      const row = await loadIntegration(ctx.tx, ws.id, id);
      const provider = getProvider(row.provider);
      let { config } = row;
      let secrets = readSecrets(app, row);
      if (input.config || input.secrets) {
        const fresh = Object.fromEntries(
          Object.entries(input.secrets ?? {}).filter(([, v]) => v !== ''),
        );
        const merged = {
          config: { ...config, ...input.config },
          secrets: { ...secrets, ...fresh },
        };
        ({ config, secrets } = provider?.configure
          ? configureOrReject(provider, merged)
          : (merged as typeof merged & { secrets: Record<string, string> }));
      }
      const [saved] = await ctx.tx
        .update(integrations)
        .set({
          name: input.name,
          config,
          secrets: sealSecrets(app, id, secrets),
          // New settings (say, switching to polling) take effect at the next tick, not an interval later.
          ...((input.config || input.secrets) && { lastPolledAt: null }),
          ...(input.enabled !== undefined && {
            status: input.enabled ? 'active' : 'disabled',
            ...(input.enabled && { lastError: null }),
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(integrations.id, id))
        .returning();
      await auditCtx(ctx, {
        action: 'integration.updated',
        targetType: 'integration',
        targetId: id,
        data: {
          name: input.name,
          enabled: input.enabled,
          config: input.config,
          secrets: input.secrets ? 'changed' : undefined,
        },
      });
      return saved!;
    });
    // New settings may mean new repositories to hook up (providers reconcile, so this is safe to repeat).
    const provider = getProvider(saved.provider);
    if ((input.config || input.secrets) && provider?.install && saved.status !== 'disabled') {
      return toIntegration(app, await installOrFlag(app, provider, saved));
    }
    return toIntegration(app, saved);
  });

  app.delete('/integrations/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const row = await loadIntegration(db, ws.id, id);
    const provider = getProvider(row.provider);
    if (provider?.uninstall) {
      try {
        await provider.uninstall(integrationContext(app, row));
      } catch (err) {
        req.log.warn({ err, integration: id }, 'integration uninstall failed');
      }
    }
    return mutate(app, req, async (ctx) => {
      await ctx.tx
        .delete(integrations)
        .where(and(eq(integrations.id, id), eq(integrations.workspaceId, ws.id)));
      // The bot stays, so its past changes keep a name; disabled, it shows as removed.
      if (row.botUserId) {
        await ctx.tx
          .update(users)
          .set({ disabledAt: new Date().toISOString() })
          .where(eq(users.id, row.botUserId));
      }
      await auditCtx(ctx, {
        action: 'integration.deleted',
        targetType: 'integration',
        targetId: id,
        data: { provider: row.provider, name: row.name },
      });
      return { ok: true };
    });
  });

  // ─── links people add by hand ─────────────────────────────────────────

  app.post('/issues/:id/links', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createIssueLinkSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const issue = await getIssue(ctx.tx, ctx.access, id);
      return upsertIssueLink(ctx, {
        issueId: issue.id,
        provider: 'web',
        kind: 'link',
        externalId: input.url,
        url: input.url,
        title:
          input.title || new URL(input.url).host + new URL(input.url).pathname.replace(/\/$/, ''),
      });
    });
  });

  app.delete('/issue-links/:id', async (req) => {
    const { id } = req.params as { id: string };
    const access = requireAccess(req);
    return mutate(app, req, async (ctx) => {
      await deleteIssueLink(ctx, id, (teamId) => canReadTeam(access, teamId));
      return { ok: true };
    });
  });
}

const claimSchema = z.object({
  provider: z.string().min(1),
  host: z.string().min(1).max(200),
  username: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[\w.-]+$/, 'Usernames are letters, digits, dots, dashes and underscores'),
});

/**
 * Forge and chat usernames people claim, so PR authors map to them. A claim isn't verified with
 * the provider: it only affects attribution, and each username can be claimed once per workspace.
 */
export async function externalAccountRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/me/external-accounts', async (req) => {
    const ws = requireWorkspace(req);
    const user = requireUser(req);
    const rows = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.workspaceId, ws.id), ne(integrations.status, 'disabled')));
    const hosts = new Map<string, { provider: string; name: string; host: string }>();
    for (const row of rows) {
      const provider = getProvider(row.provider);
      if (!provider?.accountHost) continue;
      const host = provider.accountHost(row);
      hosts.set(`${row.provider}:${host}`, { provider: row.provider, name: provider.name, host });
    }
    const claimed = await db
      .select()
      .from(externalAccounts)
      .where(
        and(
          eq(externalAccounts.workspaceId, ws.id),
          eq(externalAccounts.userId, user.id),
          isNull(externalAccounts.integrationId),
        ),
      );
    return {
      services: [...hosts.values()],
      accounts: claimed.map((a) => ({
        id: a.id,
        provider: a.provider,
        host: a.host,
        username: a.username ?? a.externalId,
      })),
    };
  });

  app.post('/me/external-accounts', async (req) => {
    const ws = requireWorkspace(req);
    const user = requireUser(req);
    const input = parse(claimSchema, req.body);
    // Chat accounts are proven with a link code, never claimed.
    if (!getProvider(input.provider)?.accountHost)
      throw badRequest(`${input.provider} usernames can't be claimed`);
    const login = input.username.toLowerCase();
    try {
      const [row] = await db
        .insert(externalAccounts)
        .values({
          workspaceId: ws.id,
          provider: input.provider,
          host: input.host,
          externalId: login,
          username: input.username,
          userId: user.id,
        })
        .onConflictDoUpdate({
          target: [
            externalAccounts.workspaceId,
            externalAccounts.provider,
            externalAccounts.host,
            externalAccounts.externalId,
          ],
          set: { username: input.username },
          // Only your own claim can be refreshed; someone else's stays theirs.
          setWhere: eq(externalAccounts.userId, user.id),
        })
        .returning();
      if (!row) throw conflict(`${input.username} is already claimed by someone else here`);
      return { id: row.id, provider: row.provider, host: row.host, username: row.username };
    } catch (err) {
      if (isUniqueViolation(err))
        throw conflict(`${input.username} is already claimed by someone else here`);
      throw err;
    }
  });

  app.delete('/me/external-accounts/:id', async (req) => {
    const ws = requireWorkspace(req);
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await db
      .delete(externalAccounts)
      .where(
        and(
          eq(externalAccounts.id, id),
          eq(externalAccounts.workspaceId, ws.id),
          eq(externalAccounts.userId, user.id),
          isNull(externalAccounts.integrationId),
        ),
      );
    return { ok: true };
  });

  // ─── chat accounts, proven with a link code ───────────────────────────

  app.get('/me/chat-accounts', async (req) => ({
    services: await chatServices(app, requireWorkspace(req).id, requireUser(req).id),
  }));

  app.post('/me/chat-accounts/:integrationId/code', async (req) => {
    const ws = requireWorkspace(req);
    const user = requireUser(req);
    const { integrationId } = req.params as { integrationId: string };
    const row = await loadIntegration(db, ws.id, integrationId);
    const provider = getProvider(row.provider);
    if (!provider?.chat || row.status === 'disabled') throw notFound('Integration');
    return {
      code: await createLinkCode(app, user.id, ws.id, row.id),
      hint: provider.chat.linkHint(row),
      expiresInMinutes: 15,
    };
  });

  app.patch('/me/chat-accounts/:id', async (req) => {
    const ws = requireWorkspace(req);
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { notify } = parse(z.object({ notify: z.boolean() }), req.body);
    const [row] = await db
      .update(externalAccounts)
      .set({ data: sql`${externalAccounts.data} || ${JSON.stringify({ notify })}::jsonb` })
      .where(and(...ownChatAccount(id, ws.id, user.id)))
      .returning({ id: externalAccounts.id });
    if (!row) throw notFound('Account');
    return { ok: true };
  });

  app.delete('/me/chat-accounts/:id', async (req) => {
    const ws = requireWorkspace(req);
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .delete(externalAccounts)
        .where(and(...ownChatAccount(id, ws.id, user.id)))
        .returning();
      if (!row) throw notFound('Account');
      await auditCtx(ctx, {
        action: 'chat_account.unlinked',
        targetType: 'integration',
        targetId: row.integrationId ?? undefined,
        data: { provider: row.provider, account: row.username ?? row.externalId },
      });
      return { ok: true };
    });
  });
}

const ownChatAccount = (id: string, workspaceId: string, userId: string) => [
  eq(externalAccounts.id, id),
  eq(externalAccounts.workspaceId, workspaceId),
  eq(externalAccounts.userId, userId),
  isNotNull(externalAccounts.integrationId),
];
