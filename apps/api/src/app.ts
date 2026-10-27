import { resolveTxt } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Sql } from 'postgres';
import { ZodError } from 'zod';
import { createDb, type Db } from './db/client.ts';
import type { Env } from './env.ts';
import { registerBuiltinProviders } from './integrations/index.ts';
import { registerJobs } from './jobs.ts';
import { authInfo, authorizeWorkspace, resolveUser } from './lib/auth.ts';
import { HttpError, validationError } from './lib/errors.ts';
import { JobQueue, Leases } from './lib/jobs/index.ts';
import { Keyring } from './lib/secrets.ts';
import { createStorage, type Storage } from './lib/storage/index.ts';
import { Realtime } from './realtime.ts';
import { accountRoutes } from './routes/account.ts';
import { adminRoutes } from './routes/admin.ts';
import { aiRoutes } from './routes/ai.ts';
import { attachmentDownloadRoutes, attachmentRoutes } from './routes/attachments.ts';
import { authRoutes } from './routes/auth.ts';
import { authProviderRoutes } from './routes/authProviders.ts';
import { customerRoutes } from './routes/customers.ts';
import { cycleRoutes } from './routes/cycles.ts';
import { documentRoutes } from './routes/documents.ts';
import { exportRoutes } from './routes/exports.ts';
import { fileRoutes } from './routes/files.ts';
import { githubCallbackRoutes, githubWorkspaceRoutes } from './routes/github.ts';
import { graphqlRoutes } from './routes/graphql.ts';
import { hookRoutes } from './routes/hooks.ts';
import { importRoutes } from './routes/imports.ts';
import { initiativeRoutes } from './routes/initiatives.ts';
import { externalAccountRoutes, integrationRoutes } from './routes/integrations.ts';
import { issueRoutes } from './routes/issues.ts';
import { joiningRoutes } from './routes/joining.ts';
import { labelRoutes } from './routes/labels.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { memberRoutes } from './routes/members.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { OAUTH_CLIENT_PATHS, oauthRoutes, wellKnownRoutes } from './routes/oauth.ts';
import { placeholderRoutes } from './routes/placeholders.ts';
import { projectRoutes } from './routes/projects.ts';
import { pushRoutes } from './routes/push.ts';
import { realtimeRoutes } from './routes/realtime.ts';
import { searchRoutes } from './routes/search.ts';
import { slackCallbackRoutes, slackWorkspaceRoutes } from './routes/slack.ts';
import { ssoRoutes } from './routes/sso.ts';
import { teamRoutes } from './routes/teams.ts';
import { templateRoutes } from './routes/templates.ts';
import { viewRoutes } from './routes/views.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { Connectors } from './services/connectors.ts';
import { Mailer } from './services/mailer.ts';
import { Settings } from './services/settings.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    sql: Sql;
    env: Env;
    realtime: Realtime;
    settings: Settings;
    keyring: Keyring;
    jobs: JobQueue;
    leases: Leases;
    connectors: Connectors;
    storage: Storage;
    mailer: Mailer;
    /** DNS TXT lookup (domain verification); replaced in tests. */
    resolveTxt: (name: string) => Promise<string[][]>;
    /** Every registered route; tests use it to make sure each one is covered by access checks. */
    routeList: { method: string; url: string }[];
  }
}

export async function buildApp(
  env: Env,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : env.production
          ? { level: env.logLevel }
          : {
              level: env.logLevel,
              transport: {
                target: 'pino-pretty',
                options: { colorize: true, ignore: 'pid,hostname' },
              },
            },
    trustProxy: env.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });

  const { db, sql: client } = createDb(env.databaseUrl);
  app.decorate('db', db);
  app.decorate('sql', client);
  app.decorate('env', env);
  app.decorate('realtime', new Realtime(client, app.log));
  app.decorate('settings', new Settings(db, client, env.settingsFromEnv, app.log));
  app.decorate('keyring', new Keyring(env.secretKey, env.previousSecretKey));
  const jobQueue = new JobQueue(db, client, app.log);
  app.decorate('jobs', jobQueue);
  const leases = new Leases(db, jobQueue.workerId);
  app.decorate('leases', leases);
  app.decorate('connectors', new Connectors(app, leases));
  app.decorate('storage', createStorage(env.storage));
  app.decorate('mailer', new Mailer(app));
  app.decorate('resolveTxt', resolveTxt);
  registerBuiltinProviders();
  registerJobs(app);
  if (!env.secretKey)
    app.log.warn('ORDO_SECRET_KEY is not set: storing secrets (SSO, integrations) is disabled');
  app.addHook('onClose', async () => {
    await app.connectors.stop();
    await app.jobs.stop();
    await client.end({ timeout: 5 });
  });

  const routeList: { method: string; url: string }[] = [];
  app.decorate('routeList', routeList);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat())
      if (method !== 'HEAD') routeList.push({ method, url: r.url });
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('authMethod', null);
  app.decorateRequest('sso', null);
  app.decorateRequest('oauth', null);
  app.decorateRequest('workspace', null);

  // Issue lists of big teams are megabytes of JSON; no proxy in front is assumed to compress.
  await app.register(compress, {
    threshold: 2048,
    brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) err = validationError(err);
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({
        error: err.code,
        message: err.message,
        details: err.details,
        messageKey: err.messageKey,
        params: err.params,
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.status(status).send({
      error: 'error',
      message: status >= 500 ? 'Internal server error' : (err as Error).message,
    });
  });

  // Resolve the caller for every API request; routes decide whether a user is required.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    rejectCrossSite(req);
    const auth = await resolveUser(db, req);
    // OAuth tokens are issued for the MCP endpoint (RFC 8707); anywhere else they're no one.
    if (auth?.oauth && req.routeOptions.url !== MCP_ROUTE) return;
    if (auth) {
      req.user = auth.user;
      req.sessionId = auth.sessionId;
      req.authMethod = auth.method;
      req.sso = auth.sso;
      req.oauth = auth.oauth ?? null;
    }
  });

  app.get('/api/health', async () => {
    await db.execute(sql`select 1`);
    return {
      ok: true,
      version: env.version,
      realtimeConnections: app.realtime.connectionCount,
      jobs: await app.jobs.stats(),
    };
  });

  await app.register(wellKnownRoutes);
  await app.register(oauthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(accountRoutes, { prefix: '/api' });
  await app.register(pushRoutes, { prefix: '/api' });
  await app.register(fileRoutes, { prefix: '/api' });
  await app.register(attachmentDownloadRoutes, { prefix: '/api' });
  await app.register(joiningRoutes, { prefix: '/api' });
  await app.register(ssoRoutes, { prefix: '/api' });
  await app.register(hookRoutes, { prefix: '/api/hooks' });
  await app.register(githubCallbackRoutes, { prefix: '/api' });
  await app.register(slackCallbackRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(realtimeRoutes, { prefix: '/api' });

  // Everything under /api/w/:ws is scoped to a workspace the caller belongs to.
  await app.register(
    async (w) => {
      w.addHook('preHandler', async (req) => {
        if (!req.user)
          throw new HttpError(401, 'Not signed in', 'unauthorized').as('not_signed_in');
        const { ws } = req.params as { ws: string };
        req.workspace = await authorizeWorkspace(db, req.user, ws, authInfo(req));
        if (req.oauth && req.oauth.workspaceId !== req.workspace.id)
          throw new HttpError(401, 'This token is for another workspace', 'unauthorized');
      });
      await w.register(workspaceRoutes);
      await w.register(memberRoutes);
      await w.register(authProviderRoutes);
      await w.register(teamRoutes);
      await w.register(cycleRoutes);
      await w.register(issueRoutes);
      await w.register(attachmentRoutes);
      await w.register(projectRoutes);
      await w.register(labelRoutes);
      await w.register(templateRoutes);
      await w.register(initiativeRoutes);
      await w.register(customerRoutes);
      await w.register(documentRoutes);
      await w.register(viewRoutes);
      await w.register(notificationRoutes);
      await w.register(searchRoutes);
      await w.register(webhookRoutes);
      await w.register(integrationRoutes);
      await w.register(importRoutes);
      await w.register(exportRoutes);
      await w.register(placeholderRoutes);
      await w.register(githubWorkspaceRoutes);
      await w.register(slackWorkspaceRoutes);
      await w.register(externalAccountRoutes);
      await w.register(mcpRoutes);
      await w.register(graphqlRoutes);
      await w.register(aiRoutes);
    },
    { prefix: '/api/w/:ws' },
  );

  // Serve the built web client as a single-page app.
  if (env.staticDir && existsSync(join(env.staticDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: env.staticDir,
      wildcard: false,
      maxAge: '1h',
      // A new service worker should take over on the next visit, not an hour later.
      setHeaders: (res, path) => {
        if (path.endsWith('sw.js')) res.header('cache-control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return reply.status(404).send({ error: 'not_found', message: 'Not found' });
      }
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.status(404).send({ error: 'not_found', message: 'Not found' }),
    );
  }

  return app;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MCP_ROUTE = '/api/w/:ws/mcp';

/**
 * Cookie sessions are SameSite=Lax and the API only parses JSON, which already stops classic
 * CSRF. This adds a header check so that stays true as form and multipart parsers are added.
 * Signed inbound webhooks (/api/hooks/*) authenticate by signature and are exempt.
 */
function rejectCrossSite(req: FastifyRequest) {
  if (SAFE_METHODS.has(req.method) || req.url.startsWith('/api/hooks/')) return;
  // Apps call the OAuth token endpoints from anywhere, authenticated by what they post, never by cookie.
  if (OAUTH_CLIENT_PATHS.has(req.url.split('?')[0]!)) return;
  if (req.headers.authorization?.startsWith('Bearer ')) return;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') throw new HttpError(403, 'Cross-site request blocked', 'forbidden');
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    // Compare through URL so default ports normalise the same way (localhost:80 ≡ localhost).
    const hostOf = (value: string) => {
      try {
        return new URL(value).host;
      } catch {
        return null;
      }
    };
    const forwarded = req.headers['x-forwarded-host'];
    const expected = hostOf(
      `${req.protocol}://${(Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host}`,
    );
    const actual = hostOf(origin);
    if (!actual || actual !== expected)
      throw new HttpError(403, 'Cross-origin request blocked', 'forbidden');
  }
}
