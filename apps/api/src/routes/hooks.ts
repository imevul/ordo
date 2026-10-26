import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { integrations } from '../db/schema.ts';
import { getProvider } from '../integrations/registry.ts';
import type { InboundRequest } from '../integrations/types.ts';
import { sha256 } from '../lib/crypto.ts';
import { notFound, unauthorized } from '../lib/errors.ts';
import { enqueue } from '../lib/jobs/index.ts';
import { readSecrets } from '../services/integrations.ts';

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

    const rows = provider.resolveInbound
      ? await provider.resolveInbound(app, hookKey, inbound)
      : await app.db
          .select()
          .from(integrations)
          .where(and(eq(integrations.provider, key), eq(integrations.inboundToken, hookKey)));
    // A switched-off integration looks like no integration at all.
    const live = rows.filter((r) => r.status !== 'disabled');
    if (!live.length) throw notFound('Hook');
    const accepted = live.filter(
      (r) => !provider.verify || provider.verify(inbound, r, readSecrets(app, r)),
    );
    if (!accepted.length) throw unauthorized('Signature mismatch');

    const deliveryId = provider.deliveryId?.(inbound) ?? sha256(inbound.body);
    for (const row of accepted) {
      await enqueue(
        app.db,
        'integration.inbound',
        { integrationId: row.id, req: inbound },
        { dedupeKey: `in:${row.id}:${deliveryId}`, orderingKey: `integration:${row.id}` },
      );
    }
    return reply.code(202).send({ ok: true });
  });
}
