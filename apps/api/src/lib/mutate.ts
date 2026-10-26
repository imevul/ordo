import type { RealtimeEvent } from '@ordo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../services/context.ts';
import { requireUser, requireWorkspace } from './auth.ts';

/** Runs `fn` in a transaction scoped to the request's workspace, then publishes its events. */
export async function mutate<T>(
  app: FastifyInstance,
  req: FastifyRequest,
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  const user = requireUser(req);
  const ws = requireWorkspace(req);
  const events: RealtimeEvent[] = [];
  const result = await app.db.transaction((tx) =>
    fn({ tx, userId: user.id, workspaceId: ws.id, events }),
  );
  app.realtime.publish(events);
  return result;
}

/** A read-only context for service functions that take a Ctx. */
export function readCtx(app: FastifyInstance, req: FastifyRequest): Ctx {
  return {
    tx: app.db,
    userId: requireUser(req).id,
    workspaceId: requireWorkspace(req).id,
    events: [],
  };
}
