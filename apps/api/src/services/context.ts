import type { RealtimeEvent } from '@ordo/shared';
import type { DbOrTx } from '../db/client.ts';

/** Per-request unit of work: the transaction, who is acting, and the events to publish after commit. */
export interface Ctx {
  tx: DbOrTx;
  userId: string;
  workspaceId: string;
  events: RealtimeEvent[];
}

export function emit(ctx: Ctx, e: Omit<RealtimeEvent, 'workspaceId' | 'actorId'>) {
  ctx.events.push({ ...e, workspaceId: ctx.workspaceId, actorId: ctx.userId });
}
