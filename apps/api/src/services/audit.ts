import { AUDIT_CATEGORIES, type AuditAction, type auditQuerySchema } from '@ordo/shared';
import { type AnyColumn, eq, gte, ilike, like, lt, or, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
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

/**
 * The conditions for an audit log query's filters. `alsoSearch` adds columns the free text should
 * match (the instance log searches actors' names and emails too).
 */
export function auditFilters(
  q: z.infer<typeof auditQuerySchema>,
  alsoSearch: AnyColumn[] = [],
): (SQL | undefined)[] {
  const prefixes = q.category ? AUDIT_CATEGORIES[q.category] : null;
  const pattern = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return [
    prefixes ? or(...prefixes.map((p) => like(auditLog.action, `${p}%`))) : undefined,
    q.actorId ? eq(auditLog.actorId, q.actorId) : undefined,
    q.from ? gte(auditLog.createdAt, q.from) : undefined,
    q.to ? lt(auditLog.createdAt, q.to) : undefined,
    pattern
      ? or(
          ilike(auditLog.action, pattern),
          ilike(auditLog.targetId, pattern),
          ilike(auditLog.ip, pattern),
          sql`${auditLog.data}::text ilike ${pattern}`,
          ...alsoSearch.map((c) => ilike(c, pattern)),
        )
      : undefined,
    // Entries made in the same transaction share a timestamp; the id breaks the tie.
    q.before
      ? q.beforeId
        ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${q.before}::timestamptz, ${q.beforeId}::uuid)`
        : lt(auditLog.createdAt, q.before)
      : undefined,
  ];
}
