import { createHmac, randomBytes } from 'node:crypto';
import type { Webhook, WebhookDelivery, WebhookPayload } from '@ordo/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { webhookDeliveries, webhooks } from '../db/schema.ts';
import { one } from '../lib/errors.ts';
import { enqueue, type JobContext } from '../lib/jobs/index.ts';
import { safeFetch } from '../lib/safeFetch.ts';
import { audit } from './audit.ts';

/**
 * Outgoing webhooks. Each delivery is a job: retried with backoff for about an hour, then marked
 * failed. An endpoint whose deliveries keep failing is switched off so it stops costing retries.
 */

export const DELIVERY_ATTEMPTS = 10;
export const DISABLE_AFTER_FAILURES = 20;
const RESPONSE_LIMIT = 2000;

type WebhookRow = typeof webhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export const webhookSecretAad = (id: string) => `webhooks:${id}:secret`;
export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

export const toWebhook = (w: WebhookRow): Webhook => ({
  id: w.id,
  url: w.url,
  description: w.description,
  eventTypes: w.eventTypes,
  teamIds: w.teamIds,
  enabled: w.enabled,
  failureCount: w.failureCount,
  disabledReason: w.disabledReason,
  lastDeliveryAt: w.lastDeliveryAt,
  lastStatus: w.lastStatus,
  createdAt: w.createdAt,
});

export const toDelivery = (d: DeliveryRow): WebhookDelivery => ({
  id: d.id,
  webhookId: d.webhookId,
  eventId: d.eventId === null ? null : String(d.eventId),
  eventType: d.eventType,
  status: d.status,
  attempts: d.attempts,
  responseStatus: d.responseStatus,
  responseBody: d.responseBody,
  error: d.error,
  durationMs: d.durationMs,
  createdAt: d.createdAt,
  deliveredAt: d.deliveredAt,
});

/** Does this webhook want the event? Empty filters mean "everything". */
export function wants(
  hook: Pick<WebhookRow, 'eventTypes' | 'teamIds'>,
  type: string,
  teamIds: string[],
) {
  if (hook.eventTypes.length && !hook.eventTypes.includes(type as never)) return false;
  if (hook.teamIds.length && !teamIds.some((t) => hook.teamIds.includes(t))) return false;
  return true;
}

/** `Ordo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` */
export function signature(secret: string, body: string, timestamp: number) {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export async function queueDelivery(
  tx: DbOrTx,
  webhookId: string,
  payload: WebhookPayload,
  eventId: number | null,
) {
  const row = one(
    await tx
      .insert(webhookDeliveries)
      .values({ webhookId, eventId, eventType: payload.type, payload })
      .returning({ id: webhookDeliveries.id }),
  );
  await enqueue(tx, 'webhook.deliver', { deliveryId: row.id }, { maxAttempts: DELIVERY_ATTEMPTS });
  return row.id;
}

export async function deliverWebhook(
  app: FastifyInstance,
  { deliveryId }: { deliveryId: string },
  job: JobContext,
) {
  const [row] = await app.db
    .select({ delivery: webhookDeliveries, hook: webhooks })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row) return;
  const { delivery, hook } = row;
  if (!hook.enabled) {
    await app.db
      .update(webhookDeliveries)
      .set({ status: 'failed', error: 'The webhook is disabled' })
      .where(eq(webhookDeliveries.id, deliveryId));
    return;
  }

  const body = JSON.stringify(delivery.payload);
  const secret = app.keyring.decrypt(hook.secret, webhookSecretAad(hook.id));
  const started = Date.now();
  let status: number | null = null;
  let text: string | null = null;
  let error: string | null = null;
  try {
    const res = await safeFetch(hook.url, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': `Ordo-Webhooks/${app.env.version}`,
        'ordo-event': delivery.eventType,
        'ordo-delivery': delivery.id,
        'ordo-signature': signature(secret, body, Math.floor(Date.now() / 1000)),
      },
      allowPrivate: app.settings.get('allowPrivateNetworkTargets'),
      timeoutMs: 10_000,
      maxBytes: 64 * 1024,
      maxRedirects: 0,
    });
    status = res.status;
    text = new TextDecoder().decode(res.body).slice(0, RESPONSE_LIMIT);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ok = status !== null && status >= 200 && status < 300;
  const last = job.attempt >= job.maxAttempts;
  const now = new Date().toISOString();

  await app.db
    .update(webhookDeliveries)
    .set({
      attempts: job.attempt,
      responseStatus: status,
      responseBody: text,
      error,
      durationMs: Date.now() - started,
      status: ok ? 'success' : last ? 'failed' : 'pending',
      deliveredAt: ok ? now : null,
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  if (ok) {
    await app.db
      .update(webhooks)
      .set({ lastDeliveryAt: now, lastStatus: status, failureCount: 0 })
      .where(eq(webhooks.id, hook.id));
    return;
  }
  if (!last) {
    await app.db
      .update(webhooks)
      .set({ lastDeliveryAt: now, lastStatus: status })
      .where(eq(webhooks.id, hook.id));
    throw new Error(`Webhook delivery failed: ${status ? `HTTP ${status}` : error}`);
  }
  const [updated] = await app.db
    .update(webhooks)
    .set({
      lastDeliveryAt: now,
      lastStatus: status,
      failureCount: sql`${webhooks.failureCount} + 1`,
    })
    .where(eq(webhooks.id, hook.id))
    .returning();
  if (updated?.enabled && updated.failureCount >= DISABLE_AFTER_FAILURES) {
    const reason = `Switched off after ${updated.failureCount} failed deliveries in a row`;
    await app.db
      .update(webhooks)
      .set({ enabled: false, disabledReason: reason })
      .where(eq(webhooks.id, hook.id));
    await audit(app.db, {
      action: 'webhook.disabled',
      workspaceId: hook.workspaceId,
      actorId: null,
      targetType: 'webhook',
      targetId: hook.id,
      data: { url: hook.url, reason },
    });
  }
}
