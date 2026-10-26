import type { RealtimeEvent } from '@ordo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActorSource, Ctx, RequestMeta } from '../services/context.ts';
import { requireUser, requireWorkspace } from './auth.ts';

export interface RunOptions {
  workspaceId: string;
  actorId: string;
  source: ActorSource;
  silent?: boolean;
  meta?: RequestMeta | null;
}

/**
 * Runs `fn` in a transaction scoped to one workspace, then publishes its realtime events.
 * Used by requests (through `mutate`) and by anything without a request: jobs, webhooks, imports.
 */
export async function runInWorkspace<T>(
  app: FastifyInstance,
  opts: RunOptions,
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  const events: RealtimeEvent[] = [];
  const result = await app.db.transaction((tx) =>
    fn({
      tx,
      userId: opts.actorId,
      workspaceId: opts.workspaceId,
      events,
      source: opts.source,
      silent: opts.silent ?? false,
      meta: opts.meta ?? null,
    }),
  );
  app.realtime.publish(events);
  return result;
}

export const requestMeta = (req: FastifyRequest): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
});

/** `runInWorkspace` for the request's user and workspace. */
export function mutate<T>(
  app: FastifyInstance,
  req: FastifyRequest,
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  return runInWorkspace(
    app,
    {
      workspaceId: requireWorkspace(req).id,
      actorId: requireUser(req).id,
      source: req.authMethod === 'api_key' ? 'api' : 'web',
      meta: requestMeta(req),
    },
    fn,
  );
}
