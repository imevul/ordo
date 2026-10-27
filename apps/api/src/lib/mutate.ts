import type { RealtimeEvent } from '@ordo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Access, systemAccess } from '../services/access.ts';
import type { ActorSource, Ctx, RequestMeta } from '../services/context.ts';
import { writeOutbox } from '../services/events.ts';
import { logChanges, stamp } from '../services/sync.ts';
import { requireUser, requireWorkspace } from './auth.ts';

export interface RunOptions {
  workspaceId: string;
  actorId: string;
  source: ActorSource;
  /** Defaults to system access (every team) — pass the user's access when acting for a person. */
  access?: Access;
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
  let cursor: Awaited<ReturnType<typeof logChanges>> = null;
  const access = opts.access ?? systemAccess(opts.workspaceId, opts.actorId);
  const result = await app.db.transaction(async (tx) => {
    const ctx: Ctx = {
      tx,
      userId: opts.actorId,
      workspaceId: opts.workspaceId,
      access,
      events,
      domainEvents: [],
      source: opts.source,
      silent: opts.silent ?? false,
      meta: opts.meta ?? null,
    };
    const value = await fn(ctx);
    // Same transaction: a rollback leaves no events behind.
    await writeOutbox(ctx);
    // Last, as it holds the workspace's log position until commit. Imports start a new epoch
    // when they finish instead of logging every row.
    cursor = opts.source === 'import' ? null : await logChanges(tx, opts.workspaceId, events);
    return value;
  });
  app.realtime.publish(stamp(events, cursor));
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
      access: requireWorkspace(req).access,
      source: req.authMethod === 'api_key' ? 'api' : 'web',
      meta: requestMeta(req),
    },
    fn,
  );
}
