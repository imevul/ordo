import type { RealtimeEvent } from '@ordo/shared';
import type { DbOrTx } from '../db/client.ts';
import type { Access } from './access.ts';

/** What caused a change. Integrations use this to ignore their own echoes. */
export type ActorSource = 'web' | 'api' | 'system' | 'import' | `integration:${string}`;

/** Request metadata recorded in the audit log. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** A unit of work: the transaction, who is acting and why, and the events to publish after commit. */
export interface Ctx {
  tx: DbOrTx;
  userId: string;
  workspaceId: string;
  /** What the actor may see and do; services scope every query by it. */
  access: Access;
  events: RealtimeEvent[];
  source: ActorSource;
  /** Suppresses notifications (imports, bulk system changes). */
  silent: boolean;
  meta: RequestMeta | null;
}

export function emit(ctx: Ctx, e: Omit<RealtimeEvent, 'workspaceId' | 'actorId'>) {
  ctx.events.push({ ...e, workspaceId: ctx.workspaceId, actorId: ctx.userId });
}
