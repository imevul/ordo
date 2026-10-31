import type { DomainEventType, HistoryChange, RealtimeEvent } from '@ordo/shared';
import type { DbOrTx } from '../db/client.ts';
import type { Access } from './access.ts';

/** What caused a change. Integrations use this to ignore their own echoes. */
export type ActorSource =
  | 'web'
  | 'api'
  | 'mcp'
  | 'system'
  | 'import'
  | 'scim'
  | `integration:${string}`;

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
  /** Outbox entries, written at the end of the transaction (see `services/events.ts`). */
  domainEvents: DomainEventDraft[];
  source: ActorSource;
  /** Suppresses notifications (imports, bulk system changes). */
  silent: boolean;
  meta: RequestMeta | null;
  /** Set while automation rules act: the rules that led here, and the one acting now. */
  automation?: { chain: string[]; rule?: { id: string; name: string } };
}

export function emit(ctx: Ctx, e: Omit<RealtimeEvent, 'workspaceId' | 'actorId'>) {
  ctx.events.push({ ...e, workspaceId: ctx.workspaceId, actorId: ctx.userId });
}

export interface DomainEventDraft {
  type: DomainEventType;
  teamIds: string[];
  data: Record<string, unknown>;
  changes?: HistoryChange[];
  /** Rules that caused it, oldest first (see `Ctx.automation`). */
  automationChain?: string[];
}

/**
 * Records a domain event for webhooks and integrations. Unlike `emit` (a cache hint for open
 * clients), this is a public, durable description of what happened, so `data` is the full entity.
 */
export function record(
  ctx: Ctx,
  type: DomainEventType,
  data: object,
  opts: { teamIds?: (string | null | undefined)[]; changes?: HistoryChange[] } = {},
) {
  ctx.domainEvents.push({
    type,
    data: data as Record<string, unknown>,
    teamIds: [...new Set((opts.teamIds ?? []).filter((t): t is string => !!t))],
    changes: opts.changes,
    automationChain: ctx.automation && [
      ...ctx.automation.chain,
      ...(ctx.automation.rule ? [ctx.automation.rule.id] : []),
    ],
  });
}
