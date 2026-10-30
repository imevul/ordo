import { createWebhookSchema, updateWebhookSchema, type WebhookPayload } from '@ordo/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { webhookDeliveries, webhooks, workspaces } from '../db/schema.ts';
import { requireAdmin } from '../lib/auth.ts';
import { secretAad } from '../lib/encryptedColumns.ts';
import { badRequest, notFound, one, parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import { auditCtx } from '../services/audit.ts';
import type { Ctx } from '../services/context.ts';
import { newWebhookSecret, queueDelivery, toDelivery, toWebhook } from '../services/webhooks.ts';

/** Outgoing webhooks, managed by workspace admins. */
export async function webhookRoutes(app: FastifyInstance) {
  const { db } = app;

  const load = async (ctx: Ctx, id: string) => {
    const [row] = await ctx.tx
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.workspaceId, ctx.workspaceId)));
    if (!row) throw notFound('Webhook');
    return row;
  };

  const checkUrl = (url: string) => {
    if (!/^https?:\/\//i.test(url))
      throw badRequest('Webhook URLs must be http or https').as('webhook_url');
  };

  app.get('/webhooks', async (req) => {
    const ws = requireAdmin(req);
    const rows = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.workspaceId, ws.id))
      .orderBy(desc(webhooks.createdAt));
    return rows.map(toWebhook);
  });

  app.post('/webhooks', async (req) => {
    requireAdmin(req);
    if (!app.keyring.available) throw badRequest('Set ORDO_SECRET_KEY before adding webhooks');
    const input = parse(createWebhookSchema, req.body);
    checkUrl(input.url);
    return mutate(app, req, async (ctx) => {
      const secret = newWebhookSecret();
      const row = one(
        await ctx.tx
          .insert(webhooks)
          .values({
            ...input,
            workspaceId: ctx.workspaceId,
            secret: 'pending',
            createdById: ctx.userId,
          })
          .returning(),
      );
      const [saved] = await ctx.tx
        .update(webhooks)
        .set({ secret: app.keyring.encrypt(secret, secretAad.webhookSecret(row.id)) })
        .where(eq(webhooks.id, row.id))
        .returning();
      await auditCtx(ctx, {
        action: 'webhook.created',
        targetType: 'webhook',
        targetId: row.id,
        data: { url: input.url },
      });
      return { webhook: toWebhook(saved!), secret };
    });
  });

  app.patch('/webhooks/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const input = parse(updateWebhookSchema, req.body);
    if (input.url) checkUrl(input.url);
    return mutate(app, req, async (ctx) => {
      await load(ctx, id);
      const row = one(
        await ctx.tx
          .update(webhooks)
          .set({
            ...input,
            // Switching it back on starts with a clean slate.
            ...(input.enabled && { failureCount: 0, disabledReason: null }),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(webhooks.id, id))
          .returning(),
        'Webhook',
      );
      await auditCtx(ctx, {
        action: 'webhook.updated',
        targetType: 'webhook',
        targetId: id,
        data: input,
      });
      return toWebhook(row);
    });
  });

  app.delete('/webhooks/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const row = await load(ctx, id);
      await ctx.tx.delete(webhooks).where(eq(webhooks.id, id));
      await auditCtx(ctx, {
        action: 'webhook.deleted',
        targetType: 'webhook',
        targetId: id,
        data: { url: row.url },
      });
      return { ok: true };
    });
  });

  app.get('/webhooks/:id/secret', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const row = await load(ctx, id);
      return { secret: app.keyring.decrypt(row.secret, secretAad.webhookSecret(id)) };
    });
  });

  app.post('/webhooks/:id/rotate-secret', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      await load(ctx, id);
      const secret = newWebhookSecret();
      await ctx.tx
        .update(webhooks)
        .set({
          secret: app.keyring.encrypt(secret, secretAad.webhookSecret(id)),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(webhooks.id, id));
      await auditCtx(ctx, {
        action: 'webhook.updated',
        targetType: 'webhook',
        targetId: id,
        data: { secret: 'rotated' },
      });
      return { secret };
    });
  });

  app.get('/webhooks/:id/deliveries', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const { limit = '50' } = req.query as { limit?: string };
    return mutate(app, req, async (ctx) => {
      await load(ctx, id);
      const rows = await ctx.tx
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, id))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(Math.min(200, Number(limit) || 50));
      return rows.map(toDelivery);
    });
  });

  app.get('/webhooks/:id/deliveries/:deliveryId', async (req) => {
    requireAdmin(req);
    const { id, deliveryId } = req.params as { id: string; deliveryId: string };
    return mutate(app, req, async (ctx) => {
      await load(ctx, id);
      const [row] = await ctx.tx
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id)));
      if (!row) throw notFound('Delivery');
      return { ...toDelivery(row), payload: row.payload };
    });
  });

  /** Sends the same payload again, as a new delivery. */
  app.post('/webhooks/:id/deliveries/:deliveryId/redeliver', async (req) => {
    requireAdmin(req);
    const { id, deliveryId } = req.params as { id: string; deliveryId: string };
    return mutate(app, req, async (ctx) => {
      const hook = await load(ctx, id);
      if (!hook.enabled) throw badRequest('Turn the webhook on first').as('webhook_off');
      const [row] = await ctx.tx
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id)));
      if (!row) throw notFound('Delivery');
      return { id: await queueDelivery(ctx.tx, id, row.payload, row.eventId) };
    });
  });

  app.post('/webhooks/:id/ping', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const hook = await load(ctx, id);
      if (!hook.enabled) throw badRequest('Turn the webhook on first').as('webhook_off');
      const [ws] = await ctx.tx
        .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspaceId));
      const payload: WebhookPayload = {
        id: `ping-${Date.now()}`,
        type: 'ping',
        createdAt: new Date().toISOString(),
        workspace: ws!,
        actor: null,
        source: 'system',
        data: { message: 'Hello from Ordo', webhookId: id },
      };
      return { id: await queueDelivery(ctx.tx, id, payload, null) };
    });
  });
}
