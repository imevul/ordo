import { createIssueLinkSchema } from '@ordo/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { integrations } from '../db/schema.ts';
import { getProvider } from '../integrations/registry.ts';
import type { IntegrationProvider } from '../integrations/types.ts';
import { requireAccess, requireAdmin } from '../lib/auth.ts';
import { badRequest, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { canReadTeam } from '../services/access.ts';
import { auditCtx } from '../services/audit.ts';
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
    if (provider.install) {
      try {
        await provider.install(integrationContext(app, row));
      } catch (err) {
        // Keep the integration so the admin can fix its settings; show why it isn't working.
        const message = err instanceof Error ? err.message : String(err);
        await db
          .update(integrations)
          .set({ status: 'error', lastError: message })
          .where(eq(integrations.id, row.id));
        return toIntegration(app, { ...row, status: 'error', lastError: message });
      }
    }
    return toIntegration(app, row);
  });

  app.patch('/integrations/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    const input = parse(updateSchema, req.body);
    return mutate(app, req, async (ctx) => {
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
      return toIntegration(app, saved!);
    });
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
