import type { AuditAction } from '@ordo/shared';
import type { DbOrTx } from '../db/client.ts';
import { auditLog } from '../db/schema.ts';
import type { Ctx, RequestMeta } from './context.ts';

export interface AuditEntry {
  action: AuditAction;
  workspaceId?: string | null;
  actorId?: string | null;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
}

/** Records a security-relevant action. Pass the transaction the change runs in, so both commit together. */
export async function audit(db: DbOrTx, entry: AuditEntry, meta?: RequestMeta | null) {
  await db.insert(auditLog).values({
    action: entry.action,
    workspaceId: entry.workspaceId ?? null,
    actorId: entry.actorId ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    data: entry.data ?? {},
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
  });
}

/** `audit` inside a workspace unit of work. */
export function auditCtx(ctx: Ctx, entry: Omit<AuditEntry, 'workspaceId' | 'actorId'>) {
  return audit(ctx.tx, { ...entry, workspaceId: ctx.workspaceId, actorId: ctx.userId }, ctx.meta);
}
