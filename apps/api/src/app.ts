import { resolveTxt } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
import { registerJobs } from './jobs.ts';
import { authorizeWorkspace, resolveUser } from './lib/auth.ts';
import { HttpError, validationError } from './lib/errors.ts';
import { JobQueue, Leases } from './lib/jobs/index.ts';
import { Keyring } from './lib/secrets.ts';
import { createStorage, type Storage } from './lib/storage/index.ts';
import { Realtime } from './realtime.ts';
import { accountRoutes } from './routes/account.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { cycleRoutes } from './routes/cycles.ts';
import { fileRoutes } from './routes/files.ts';
import { issueRoutes } from './routes/issues.ts';
import { joiningRoutes } from './routes/joining.ts';
import { labelRoutes } from './routes/labels.ts';
import { memberRoutes } from './routes/members.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { projectRoutes } from './routes/projects.ts';
import { realtimeRoutes } from './routes/realtime.ts';
import { searchRoutes } from './routes/search.ts';
import { teamRoutes } from './routes/teams.ts';
import { viewRoutes } from './routes/views.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
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
  app.decorate('leases', new Leases(db, jobQueue.workerId));
  app.decorate('storage', createStorage(env.storage));
  app.decorate('mailer', new Mailer(app));
  app.decorate('resolveTxt', resolveTxt);
  registerJobs(app);
  if (!env.secretKey)
    app.log.warn('ORDO_SECRET_KEY is not set: storing secrets (SSO, integrations) is disabled');
  app.addHook('onClose', async () => {
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
  app.decorateRequest('workspace', null);

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) err = validationError(err);
    if (err instanceof HttpError) {
      return reply
        .status(err.statusCode)
        .send({ error: err.code, message: err.message, details: err.details });
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
    if (auth) {
      req.user = auth.user;
      req.sessionId = auth.sessionId;
      req.authMethod = auth.method;
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

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(accountRoutes, { prefix: '/api' });
  await app.register(fileRoutes, { prefix: '/api' });
  await app.register(joiningRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(realtimeRoutes, { prefix: '/api' });

  // Everything under /api/w/:ws is scoped to a workspace the caller belongs to.
  await app.register(
    async (w) => {
      w.addHook('preHandler', async (req) => {
        if (!req.user) throw new HttpError(401, 'Not signed in', 'unauthorized');
        const { ws } = req.params as { ws: string };
        req.workspace = await authorizeWorkspace(db, req.user, ws);
      });
      await w.register(workspaceRoutes);
      await w.register(memberRoutes);
      await w.register(teamRoutes);
      await w.register(cycleRoutes);
      await w.register(issueRoutes);
      await w.register(projectRoutes);
      await w.register(labelRoutes);
      await w.register(viewRoutes);
      await w.register(notificationRoutes);
      await w.register(searchRoutes);
    },
    { prefix: '/api/w/:ws' },
  );

  // Serve the built web client as a single-page app.
  if (env.staticDir && existsSync(join(env.staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: env.staticDir, wildcard: false, maxAge: '1h' });
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

/**
 * Cookie sessions are SameSite=Lax and the API only parses JSON, which already stops classic
 * CSRF. This adds a header check so that stays true as form and multipart parsers are added.
 * Signed inbound webhooks (/api/hooks/*) authenticate by signature and are exempt.
 */
function rejectCrossSite(req: FastifyRequest) {
  if (SAFE_METHODS.has(req.method) || req.url.startsWith('/api/hooks/')) return;
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
