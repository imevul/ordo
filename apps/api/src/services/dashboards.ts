import {
  AGENT_RUN_OPEN,
  type AgentActivityReport,
  type CreateDashboardInput,
  type Dashboard,
  dashboardWidgetSchema,
  type UpdateDashboardInput,
} from '@ordo/shared';
import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { agentRuns, dashboards, issues } from '../db/schema.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { type Access, assertTeamAccess, canAdminTeam, teamScope } from './access.ts';
import { type Ctx, emit } from './context.ts';

type Row = typeof dashboards.$inferSelect;

export const toDashboard = (d: Row): Dashboard => ({
  id: d.id,
  name: d.name,
  description: d.description,
  ownerId: d.ownerId,
  teamId: d.teamId,
  shared: d.shared,
  // Parsed again so widgets saved before a field had a default read as if they had it.
  widgets: d.widgets.flatMap((w) => {
    const parsed = dashboardWidgetSchema.safeParse(w);
    return parsed.success ? [parsed.data] : [];
  }),
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/** Shared ones and the caller's own, leaving out those of teams the caller can't read. */
const visible = (access: Access) => {
  const teams = teamScope(access, dashboards.teamId);
  return and(
    eq(dashboards.workspaceId, access.workspaceId),
    or(eq(dashboards.shared, true), eq(dashboards.ownerId, access.userId)),
    teams && or(isNull(dashboards.teamId), teams),
  );
};

export async function listDashboards(db: DbOrTx, access: Access): Promise<Dashboard[]> {
  const rows = await db
    .select()
    .from(dashboards)
    .where(visible(access))
    .orderBy(asc(dashboards.name));
  return rows.map(toDashboard);
}

export async function getDashboard(db: DbOrTx, access: Access, id: string) {
  const [row] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.id, id), visible(access)));
  if (!row) throw notFound('Dashboard');
  return row;
}

/**
 * Dashboards are changed by their owner or a workspace admin, and a team's shared dashboard by
 * the team's admins too (the team lead keeps the team's page). Admins inherit ownerless ones.
 */
async function loadEditable(ctx: Ctx, id: string) {
  const row = await getDashboard(ctx.tx, ctx.access, id);
  const teamAdmin = !!row.teamId && row.shared && canAdminTeam(ctx.access, row.teamId);
  if (row.ownerId !== ctx.userId && !ctx.access.isAdmin && !teamAdmin)
    throw forbidden('Only the owner, a team admin or an admin can change this dashboard').as(
      'dashboard_change',
    );
  return row;
}

export async function createDashboard(ctx: Ctx, input: CreateDashboardInput) {
  if (input.teamId) assertTeamAccess(ctx.access, input.teamId);
  const [row] = await ctx.tx
    .insert(dashboards)
    .values({
      workspaceId: ctx.workspaceId,
      ownerId: ctx.userId,
      name: input.name,
      description: input.description ?? null,
      teamId: input.teamId ?? null,
      shared: input.shared,
      widgets: input.widgets,
    })
    .returning();
  emit(ctx, {
    kind: 'dashboard',
    action: 'created',
    id: row!.id,
    teamId: row!.teamId ?? undefined,
  });
  return toDashboard(row!);
}

export async function updateDashboard(ctx: Ctx, id: string, input: UpdateDashboardInput) {
  const current = await loadEditable(ctx, id);
  // Only the owner decides who sees it; an admin editing someone's page doesn't hide it from them.
  if (input.shared !== undefined && current.ownerId !== ctx.userId && !ctx.access.isAdmin)
    throw forbidden('Only the owner can share or unshare this dashboard').as('dashboard_share');
  const [row] = await ctx.tx
    .update(dashboards)
    .set({ ...input, updatedAt: new Date().toISOString() })
    .where(eq(dashboards.id, id))
    .returning();
  emit(ctx, { kind: 'dashboard', action: 'updated', id, teamId: row!.teamId ?? undefined });
  return toDashboard(row!);
}

export async function deleteDashboard(ctx: Ctx, id: string) {
  const row = await loadEditable(ctx, id);
  await ctx.tx.delete(dashboards).where(eq(dashboards.id, id));
  emit(ctx, { kind: 'dashboard', action: 'deleted', id, teamId: row.teamId ?? undefined });
}

const DAY = 86_400_000;

/**
 * Agent runs started in the last `days` days on issues `access` can read, per agent: how many,
 * how they ended, what's still open, and what they cost.
 */
export async function agentActivity(
  db: DbOrTx,
  access: Access,
  q: { days: number; agentId?: string; teamId?: string },
): Promise<AgentActivityReport> {
  if (q.teamId) assertTeamAccess(access, q.teamId);
  const since = new Date(Date.now() - q.days * DAY).toISOString();
  const open = sql.join(
    AGENT_RUN_OPEN.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = await db
    .select({
      agentId: agentRuns.agentId,
      runs: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
      open: sql<number>`count(*) filter (where ${agentRuns.status} in (${open}))::int`,
      costUsd: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float8`,
      durationMs: sql<number>`coalesce(sum(${agentRuns.durationMs}), 0)::float8`,
    })
    .from(agentRuns)
    .innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(
      and(
        eq(agentRuns.workspaceId, access.workspaceId),
        gte(agentRuns.createdAt, since),
        teamScope(access, issues.teamId),
        q.teamId ? eq(issues.teamId, q.teamId) : undefined,
        q.agentId ? eq(agentRuns.agentId, q.agentId) : undefined,
      ),
    )
    .groupBy(agentRuns.agentId)
    .orderBy(sql`count(*) desc`);
  return { since, agents: rows };
}
