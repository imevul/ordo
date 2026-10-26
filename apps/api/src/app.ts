import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { ZodError } from 'zod';
import { createDb, type Db } from './db/client.ts';
import type { Env } from './env.ts';
import { resolveUser, resolveWorkspace } from './lib/auth.ts';
import { HttpError, validationError } from './lib/errors.ts';
import { Realtime } from './realtime.ts';
import { authRoutes } from './routes/auth.ts';
import { cycleRoutes } from './routes/cycles.ts';
import { issueRoutes } from './routes/issues.ts';
import { labelRoutes } from './routes/labels.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { projectRoutes } from './routes/projects.ts';
import { realtimeRoutes } from './routes/realtime.ts';
import { searchRoutes } from './routes/search.ts';
import { teamRoutes } from './routes/teams.ts';
import { viewRoutes } from './routes/views.ts';
import { workspaceRoutes } from './routes/workspaces.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    sql: Sql;
    env: Env;
    realtime: Realtime;
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
  app.addHook('onClose', async () => {
    await client.end({ timeout: 5 });
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
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
    const auth = await resolveUser(db, req);
    if (auth) {
      req.user = auth.user;
      req.sessionId = auth.sessionId;
    }
  });

  app.get('/api/health', async () => {
    await db.execute(sql`select 1`);
    return { ok: true, version: env.version, realtimeConnections: app.realtime.connectionCount };
  });

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(realtimeRoutes, { prefix: '/api' });

  // Everything under /api/w/:ws is scoped to a workspace the caller belongs to.
  await app.register(
    async (w) => {
      w.addHook('preHandler', async (req) => {
        if (!req.user) throw new HttpError(401, 'Not signed in', 'unauthorized');
        const { ws } = req.params as { ws: string };
        req.workspace = await resolveWorkspace(db, req.user.id, ws);
      });
      await w.register(workspaceRoutes);
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
