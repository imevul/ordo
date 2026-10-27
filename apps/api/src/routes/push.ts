import { pushSubscriptionSchema } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pushSubscriptions } from '../db/schema.ts';
import { requireUser } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { unsubscribePush, vapidKeys } from '../services/push.ts';

/** Web push: the server's public key, and the caller's devices subscribing or leaving. */
export async function pushRoutes(app: FastifyInstance) {
  app.get('/push/key', async () => ({ publicKey: (await vapidKeys(app)).publicKey }));

  app.post('/me/push-subscriptions', async (req) => {
    const user = requireUser(req);
    const { endpoint, keys } = parse(pushSubscriptionSchema, req.body);
    const values = {
      userId: user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    };
    // A device signing in as someone else takes the subscription with it.
    await app.db
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
    return { ok: true };
  });

  app.delete('/me/push-subscriptions', async (req) => {
    const user = requireUser(req);
    const { endpoint } = parse(z.object({ endpoint: z.string().max(2000) }), req.body);
    await unsubscribePush(app.db, user.id, endpoint);
    return { ok: true };
  });
}
