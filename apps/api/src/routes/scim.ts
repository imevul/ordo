import { createScimTokenSchema } from '@ordo/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { scimTokens, users } from '../db/schema.ts';
import { requireAdmin } from '../lib/auth.ts';
import { sha256 } from '../lib/crypto.ts';
import { HttpError, notFound, parse } from '../lib/errors.ts';
import { mutate, requestMeta, runInWorkspace } from '../lib/mutate.ts';
import { systemAccess } from '../services/access.ts';
import { auditCtx } from '../services/audit.ts';
import type { Ctx } from '../services/context.ts';
import {
  createScimToken,
  createScimUser,
  deleteScimUser,
  directoryBot,
  getScimUser,
  listScimUsers,
  resourceTypes,
  SCIM_SCHEMA,
  ScimError,
  schemas,
  scimTokenWorkspace,
  serviceProviderConfig,
  toScimToken,
  updateScimUser,
} from '../services/scim.ts';

declare module 'fastify' {
  interface FastifyRequest {
    scim?: { workspaceId: string; tokenId: string; botId: string };
  }
}

const SCIM_JSON = 'application/scim+json';

/**
 * /api/scim/v2: the SCIM service provider. Outside /api/w/:ws on purpose: the token says which
 * workspace, and identity providers expect one base URL per connection.
 */
export async function scimRoutes(app: FastifyInstance) {
  const baseUrl = `${app.env.publicUrl}/api/scim/v2`;

  app.addContentTypeParser(
    SCIM_JSON,
    { parseAs: 'string' },
    app.getDefaultJsonParser('error', 'error'),
  );

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const found = token ? await scimTokenWorkspace(app.db, token) : null;
    if (!found) throw new ScimError(401, 'A SCIM token is required');
    req.scim = {
      workspaceId: found.workspaceId,
      tokenId: found.id,
      botId: await directoryBot(app.db, found.workspaceId),
    };
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status =
      err instanceof ScimError
        ? err.status
        : err instanceof HttpError
          ? err.statusCode
          : (err.statusCode ?? 500);
    if (status >= 500) req.log.error({ err }, 'SCIM request failed');
    return reply
      .status(status)
      .type(SCIM_JSON)
      .send({
        schemas: [SCIM_SCHEMA.error],
        status: String(status),
        ...(err instanceof ScimError && err.scimType && { scimType: err.scimType }),
        detail: status >= 500 ? 'Internal error' : err.message,
      });
  });

  // One token can't starve the instance; a full sync of a big directory stays well under this.
  const limit = {
    config: {
      rateLimit: {
        max: 1200,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => req.scim?.tokenId ?? sha256(req.ip),
      },
    },
  };

  /** Runs as the workspace's Directory sync bot. Reads too, for one consistent snapshot. */
  const run = <T>(req: FastifyRequest, fn: (ctx: Ctx) => Promise<T>) => {
    const { workspaceId, botId } = req.scim!;
    return runInWorkspace(
      app,
      {
        workspaceId,
        actorId: botId,
        access: systemAccess(workspaceId, botId),
        source: 'scim',
        meta: requestMeta(req),
      },
      fn,
    );
  };
  const send = (reply: FastifyReply, body: unknown, status = 200) =>
    reply.status(status).type(SCIM_JSON).send(body);

  app.get('/ServiceProviderConfig', limit, async (_req, reply) =>
    send(reply, serviceProviderConfig(baseUrl)),
  );
  app.get('/ResourceTypes', limit, async (_req, reply) => {
    const list = resourceTypes(baseUrl);
    return send(reply, {
      schemas: [SCIM_SCHEMA.list],
      totalResults: list.length,
      startIndex: 1,
      itemsPerPage: list.length,
      Resources: list,
    });
  });
  app.get('/Schemas', limit, async (_req, reply) => {
    const list = schemas(baseUrl);
    return send(reply, {
      schemas: [SCIM_SCHEMA.list],
      totalResults: list.length,
      startIndex: 1,
      itemsPerPage: list.length,
      Resources: list,
    });
  });

  app.get('/Users', limit, async (req, reply) =>
    send(reply, await run(req, (ctx) => listScimUsers(ctx, baseUrl, req.query as object))),
  );
  app.get('/Users/:id', limit, async (req, reply) => {
    const { id } = req.params as { id: string };
    return send(reply, await run(req, (ctx) => getScimUser(ctx, baseUrl, id)));
  });
  app.post('/Users', limit, async (req, reply) =>
    send(reply, await run(req, (ctx) => createScimUser(ctx, baseUrl, req.body)), 201),
  );
  app.put('/Users/:id', limit, async (req, reply) => {
    const { id } = req.params as { id: string };
    return send(reply, await run(req, (ctx) => updateScimUser(ctx, baseUrl, id, req.body, 'put')));
  });
  app.patch('/Users/:id', limit, async (req, reply) => {
    const { id } = req.params as { id: string };
    return send(
      reply,
      await run(req, (ctx) => updateScimUser(ctx, baseUrl, id, req.body, 'patch')),
    );
  });
  app.delete('/Users/:id', limit, async (req, reply) => {
    const { id } = req.params as { id: string };
    await run(req, (ctx) => deleteScimUser(ctx, id));
    return reply.status(204).send();
  });
}

/** Settings → Authentication → Directory sync: admins issue and revoke SCIM tokens. */
export async function scimAdminRoutes(app: FastifyInstance) {
  app.get('/scim/tokens', async (req) => {
    const ws = requireAdmin(req);
    const rows = await app.db
      .select({ token: scimTokens, createdBy: users.name })
      .from(scimTokens)
      .leftJoin(users, eq(users.id, scimTokens.createdById))
      .where(eq(scimTokens.workspaceId, ws.id))
      .orderBy(desc(scimTokens.createdAt));
    return {
      tokens: rows.map((r) => toScimToken(r.token, r.createdBy)),
      baseUrl: `${app.env.publicUrl}/api/scim/v2`,
    };
  });

  /** The token itself is in this response only. */
  app.post('/scim/tokens', async (req) => {
    requireAdmin(req);
    const { name } = parse(createScimTokenSchema, req.body);
    return mutate(app, req, async (ctx) => {
      const { token, row } = await createScimToken(ctx, name);
      return { ...toScimToken(row), token };
    });
  });

  app.delete('/scim/tokens/:id', async (req) => {
    const ws = requireAdmin(req);
    const { id } = req.params as { id: string };
    return mutate(app, req, async (ctx) => {
      const [row] = await ctx.tx
        .delete(scimTokens)
        .where(and(eq(scimTokens.id, id), eq(scimTokens.workspaceId, ws.id)))
        .returning();
      if (!row) throw notFound('Token');
      await auditCtx(ctx, {
        action: 'scim.token_deleted',
        targetType: 'scim_token',
        targetId: id,
        data: { name: row.name },
      });
      return { ok: true };
    });
  });
}
