import {
  aiDraftSchema,
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceAi,
  workspaceAiProviderSchema,
} from '@ordo/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { workspaceAiProviders, workspaces } from '../db/schema.ts';
import { requireAdmin, requireWorkspace } from '../lib/auth.ts';
import { badRequest, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  assertAiChangeAllowed,
  draftIssue,
  effectiveAiSettings,
  ownAiProvider,
  ownModel,
  summarizeIssue,
  triageIssue,
  workspaceModel,
} from '../services/ai/assist.ts';
import { auditCtx } from '../services/audit.ts';
import { emit } from '../services/context.ts';
import type { McpReader } from '../services/mcp.ts';
import { workspaceAiKeyAad } from '../services/secretKey.ts';

const maskKey = (key: string) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '••••');

/**
 * AI assistance (services/ai). Nothing here changes data: answers are suggestions the web app
 * shows, and people apply them through the usual endpoints. Workspace admins choose the model
 * under /ai/settings: the instance's, their own (/ai/provider), or none.
 */
export async function aiRoutes(app: FastifyInstance) {
  // Each request costs the instance money or GPU time.
  const limited = {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip,
      },
    },
  };

  const prepare = async (req: FastifyRequest) => {
    const ws = requireWorkspace(req);
    const model = await workspaceModel(app, ws.id);
    const reader: McpReader = { app, access: ws.access, workspace: ws };
    return { model, reader };
  };

  app.post<{ Params: { id: string } }>('/ai/issues/:id/summary', limited, async (req) => {
    const { model, reader } = await prepare(req);
    return summarizeIssue(model, reader, req.params.id);
  });

  app.post<{ Params: { id: string } }>('/ai/issues/:id/triage', limited, async (req) => {
    const { model, reader } = await prepare(req);
    return triageIssue(model, reader, req.params.id);
  });

  app.post('/ai/draft', limited, async (req) => {
    const input = parse(aiDraftSchema, req.body);
    const { model, reader } = await prepare(req);
    return draftIssue(model, reader, input);
  });

  // ─── the workspace's choice of model ─────────────────────────────────

  app.get('/ai/settings', async (req): Promise<WorkspaceAi> => {
    const ws = requireAdmin(req);
    const [row] = await app.db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws.id));
    const settings = effectiveAiSettings(app, { ...DEFAULT_WORKSPACE_SETTINGS, ...row?.settings });
    const instance = app.settings.get('ai');
    const own = await ownAiProvider(app, ws.id);
    return {
      enabled: settings.aiEnabled,
      source: settings.aiSource,
      instance: instance ? { provider: instance.provider, model: instance.model } : null,
      own: own ? { ...own, apiKey: own.apiKey ? maskKey(own.apiKey) : null } : null,
      allowPrivateNetwork: app.settings.get('allowPrivateNetworkTargets'),
      policy: app.settings.get('workspaceAi'),
    };
  });

  /** Saves the workspace's own model and switches the workspace to it. */
  app.put('/ai/provider', async (req) => {
    requireAdmin(req);
    if (!app.keyring.available) throw badRequest('Set ORDO_SECRET_KEY first');
    assertAiChangeAllowed(app, { ownModel: true });
    const input = parse(workspaceAiProviderSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const [current] = await ctx.tx
        .select({ apiKey: workspaceAiProviders.apiKey })
        .from(workspaceAiProviders)
        .where(eq(workspaceAiProviders.workspaceId, ctx.workspaceId));
      // An empty key keeps the stored one (the page only ever sees it masked); null removes it.
      const apiKey =
        input.apiKey === ''
          ? (current?.apiKey ?? null)
          : input.apiKey && app.keyring.encrypt(input.apiKey, workspaceAiKeyAad(ctx.workspaceId));
      if (input.provider === 'anthropic' && !apiKey)
        throw badRequest('Enter an API key for the Claude API');
      if (input.provider === 'openai' && !input.baseUrl)
        throw badRequest('Enter the base URL of the OpenAI-compatible endpoint');
      const values = {
        provider: input.provider,
        model: input.model,
        baseUrl: input.provider === 'openai' ? (input.baseUrl?.replace(/\/$/, '') ?? null) : null,
        apiKey,
        updatedAt: new Date().toISOString(),
      };
      await ctx.tx
        .insert(workspaceAiProviders)
        .values({ workspaceId: ctx.workspaceId, ...values })
        .onConflictDoUpdate({ target: workspaceAiProviders.workspaceId, set: values });
      await setAiSource(ctx, 'workspace');
      await auditCtx(ctx, {
        action: 'workspace.ai_updated',
        targetType: 'workspace',
        targetId: ctx.workspaceId,
        data: {
          source: 'workspace',
          provider: input.provider,
          model: input.model,
          baseUrl: values.baseUrl,
          apiKey: input.apiKey === '' ? 'kept' : input.apiKey ? 'changed' : null,
        },
      });
      return { ok: true };
    });
  });

  /** Forgets the workspace's own model; the workspace goes back to the instance's. */
  app.delete('/ai/provider', async (req) => {
    requireAdmin(req);
    return mutate(app, req, async (ctx) => {
      await ctx.tx
        .delete(workspaceAiProviders)
        .where(eq(workspaceAiProviders.workspaceId, ctx.workspaceId));
      await setAiSource(ctx, 'instance');
      await auditCtx(ctx, {
        action: 'workspace.ai_updated',
        targetType: 'workspace',
        targetId: ctx.workspaceId,
        data: { source: 'instance', removed: true },
      });
      return { ok: true };
    });
  });

  // A one-line request to the workspace's own model, so admins see a bad key or URL right away.
  app.post(
    '/ai/provider/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const ws = requireAdmin(req);
      assertAiChangeAllowed(app, { ownModel: true });
      const own = await ownAiProvider(app, ws.id);
      if (!own)
        throw badRequest("This workspace's own AI model isn't set up").as(
          'ai_not_set_up_workspace',
        );
      const started = Date.now();
      const reply = await ownModel(app, own).complete({
        system: 'You check that a connection works.',
        prompt: 'Reply with the single word: ready',
        maxTokens: 2000,
      });
      return { reply: reply.trim().slice(0, 200), ms: Date.now() - started };
    },
  );
}

/** Points the workspace at its own model or the instance's (members' pages refresh). */
async function setAiSource(
  ctx: Parameters<Parameters<typeof mutate>[2]>[0],
  source: 'instance' | 'workspace',
) {
  const [row] = await ctx.tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId));
  await ctx.tx
    .update(workspaces)
    .set({ settings: { ...row?.settings, aiSource: source } })
    .where(eq(workspaces.id, ctx.workspaceId));
  emit(ctx, { kind: 'workspace', action: 'updated', id: ctx.workspaceId });
}
