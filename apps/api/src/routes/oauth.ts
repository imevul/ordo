import { type OAuthAuthorizeInfo, oauthAuthorizeQuerySchema } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { oauthClients, oauthGrants } from '../db/schema.ts';
import { authInfo, authorizeWorkspace, requireUser } from '../lib/auth.ts';
import { HttpError, tryParse, unauthorized } from '../lib/errors.ts';
import { requestMeta } from '../lib/mutate.ts';
import { audit } from '../services/audit.ts';
import {
  authenticateClient,
  authorizationServerMetadata,
  checkAuthorizeRequest,
  clientInfo,
  exchangeCode,
  issueCode,
  listGrants,
  OAuthError,
  protectedResourceMetadata,
  redirectWith,
  refreshTokens,
  registerClient,
  revokeToken,
} from '../services/oauth.ts';

type Params = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Endpoints apps call directly, cookie-free and from any origin. */
export const OAUTH_CLIENT_PATHS = new Set([
  '/api/oauth/token',
  '/api/oauth/register',
  '/api/oauth/revoke',
]);

function cors(reply: FastifyReply) {
  reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version')
    .header('access-control-max-age', '86400');
}

/** Discovery documents, at the origin root where RFC 8414 and RFC 9728 put them. */
export async function wellKnownRoutes(app: FastifyInstance) {
  const preflight = async (_req: FastifyRequest, reply: FastifyReply) => {
    cors(reply);
    return reply.status(204).send();
  };
  const as = '/.well-known/oauth-authorization-server';
  app.get(as, async (_req, reply) => {
    cors(reply);
    return authorizationServerMetadata(app);
  });
  app.options(as, preflight);

  // Answered for any well-formed slug, so it says nothing about which workspaces exist.
  const prm = '/.well-known/oauth-protected-resource/api/w/:ws/mcp';
  app.get(prm, async (req, reply) => {
    cors(reply);
    const { ws } = req.params as { ws: string };
    if (!/^[a-z0-9-]+$/.test(ws)) throw new HttpError(404, 'Not found', 'not_found');
    return protectedResourceMetadata(app, ws);
  });
  app.options(prm, preflight);
}

export async function oauthRoutes(app: FastifyInstance) {
  const { db } = app;

  await app.register(async (pub) => {
    pub.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    // Errors in RFC 6749 §5.2 form; nothing here may be cached.
    pub.setErrorHandler((err: Error, req, reply) => {
      cors(reply);
      reply.header('cache-control', 'no-store');
      if (err instanceof OAuthError) {
        if (err.status === 401 && req.headers.authorization?.startsWith('Basic '))
          reply.header('www-authenticate', 'Basic realm="Ordo"');
        return reply.status(err.status).send({ error: err.error, error_description: err.message });
      }
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      if (status >= 500) {
        req.log.error({ err }, 'oauth request failed');
        return reply.status(500).send({ error: 'server_error' });
      }
      return reply
        .status(status)
        .send({ error: 'invalid_request', error_description: err.message });
    });
    pub.addHook('onSend', async (_req, reply) => {
      cors(reply);
      reply.header('cache-control', 'no-store');
    });
    const body = (req: FastifyRequest) =>
      req.body && typeof req.body === 'object' ? (req.body as Params) : {};

    pub.post(
      '/oauth/register',
      { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
      async (req, reply) => reply.status(201).send(await registerClient(app, body(req))),
    );

    pub.post(
      '/oauth/token',
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (req) => {
        const params = body(req);
        const client = await authenticateClient(app, params, req.headers.authorization);
        switch (params.grant_type) {
          case 'authorization_code':
            return exchangeCode(app, client, params);
          case 'refresh_token':
            return refreshTokens(app, client, params);
          default:
            throw new OAuthError(
              'unsupported_grant_type',
              'Use authorization_code or refresh_token',
            );
        }
      },
    );

    pub.post('/oauth/revoke', async (req, reply) => {
      const params = body(req);
      const client = await authenticateClient(app, params, req.headers.authorization);
      await revokeToken(app, client, params);
      return reply.status(200).send({});
    });

    for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke'])
      pub.options(path, async (_req, reply) => reply.status(204).send());
  });

  /**
   * The consent screen's side. The page lives at /oauth/authorize in the web app, which reads the
   * request here and posts the person's answer back.
   */
  async function authorizeRequest(req: FastifyRequest, params: unknown) {
    const user = requireUser(req);
    // Only a person in the browser can say yes, not an API key.
    if (req.authMethod !== 'session') throw unauthorized();
    // Nothing to send back to before the client and redirect_uri check out, so a malformed
    // request (a repeated parameter) is answered here, on the consent page.
    const query = tryParse(oauthAuthorizeQuerySchema, params);
    if (!query)
      throw new HttpError(
        400,
        'This authorization request is malformed: a parameter is repeated or too long',
        'invalid_request',
      );
    try {
      const r = await checkAuthorizeRequest(app, query);
      const ws = await authorizeWorkspace(db, user, r.slug, authInfo(req));
      return { r, ws, user };
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      throw new HttpError(400, err.message, err.error, err.redirect && { redirect: err.redirect });
    }
  }

  app.get('/oauth/authorize', async (req): Promise<OAuthAuthorizeInfo> => {
    const { r, ws } = await authorizeRequest(req, req.query);
    return {
      client: clientInfo(r.client),
      workspace: { name: ws.name, slug: ws.slug },
      redirectUri: r.redirectUri,
    };
  });

  app.post('/oauth/authorize', async (req) => {
    const params = (req.body ?? {}) as Params & { approve?: unknown };
    const { r, ws, user } = await authorizeRequest(req, params);
    if (params.approve !== true)
      return {
        redirect: redirectWith(app, r.redirectUri, r.state, {
          error: 'access_denied',
          error_description: 'The person declined',
        }),
      };
    const code = await issueCode(app, r, {
      userId: user.id,
      workspaceId: ws.id,
      sso: req.sso,
    });
    await audit(
      db,
      {
        action: 'oauth.authorized',
        workspaceId: ws.id,
        actorId: user.id,
        targetType: 'oauth_client',
        targetId: r.client.id,
        data: { client: r.client.name, clientId: r.client.clientId },
      },
      requestMeta(req),
    );
    return { redirect: redirectWith(app, r.redirectUri, r.state, { code }) };
  });

  app.get('/me/oauth-grants', async (req) => listGrants(db, requireUser(req).id));

  app.delete('/me/oauth-grants/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return { ok: true };
    await db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(oauthGrants)
        .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, user.id)))
        .returning({ workspaceId: oauthGrants.workspaceId, clientId: oauthGrants.clientId });
      if (!removed) return;
      const [client] = await tx
        .select({ name: oauthClients.name })
        .from(oauthClients)
        .where(eq(oauthClients.id, removed.clientId));
      await audit(
        tx,
        {
          action: 'oauth.revoked',
          workspaceId: removed.workspaceId,
          actorId: user.id,
          targetType: 'oauth_client',
          targetId: removed.clientId,
          data: { client: client?.name },
        },
        requestMeta(req),
      );
    });
    return { ok: true };
  });
}
