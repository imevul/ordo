import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { integrations } from '../db/schema.ts';
import { getProvider } from '../integrations/registry.ts';
import type { InboundRequest } from '../integrations/types.ts';
import { notFound, unauthorized } from '../lib/errors.ts';
import { allSecrets, queueInbound } from '../services/integrations.ts';

const BODY_LIMIT = 25 * 1024 * 1024;

/**
 * POST /api/hooks/:provider/:key — inbound webhooks from outside services.
 *
 * Bodies stay raw (signatures cover the exact bytes) and anything goes as content type. The
 * request is verified, queued with the delivery id as idempotency key, and answered 202 at once;
 * the provider processes it in a job.
 */
export async function hookRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/:provider/:key', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const { provider: key, key: hookKey } = req.params as { provider: string; key: string };
    const provider = getProvider(key);
    if (!provider?.handleInbound) throw notFound('Hook');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === 'cookie' || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const inbound: InboundRequest = {
      headers,
      query: req.query as Record<string, string>,
      body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '',
    };

    const handshake = await provider.challenge?.(app, hookKey, inbound);
    if (handshake) return reply.code(handshake.status ?? 200).send(handshake.body ?? '');

    const rows = provider.resolveInbound
      ? await provider.resolveInbound(app, hookKey, inbound)
      : await app.db
          .select()
          .from(integrations)
          .where(and(eq(integrations.provider, key), eq(integrations.inboundToken, hookKey)));
    // A switched-off integration looks like no integration at all, and one that holds its own
    // connection (Socket Mode, a gateway, a long poll) takes nothing from outside.
    const live = rows.filter((r) => r.status !== 'disabled' && !provider.wantsConnection?.(r));
    if (!live.length) throw notFound('Hook');
    const accepted: typeof live = [];
    for (const row of live) {
      if (!provider.verify || provider.verify(inbound, row, await allSecrets(app, row)))
        accepted.push(row);
    }
    if (!accepted.length) throw unauthorized('Signature mismatch');

    // Some services want an answer within the request (a URL challenge, an interaction ack).
    const ack = provider.ackInbound?.(inbound, accepted[0]!, await allSecrets(app, accepted[0]!));
    if (ack?.process !== false) {
      for (const row of accepted) await queueInbound(app, provider, row, inbound);
    }
    if (ack) return reply.code(ack.status ?? 200).send(ack.body ?? '');
    return reply.code(202).send({ ok: true });
  });
}
