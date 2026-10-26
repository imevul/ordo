import { DEFAULT_WORKFLOW_STATES, SORT_GAP, type Team } from '@ordo/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { teamMembers, teams, workflowStates } from '../db/schema.ts';
import { type Access, teamScope } from './access.ts';
import { type Ctx, emit } from './context.ts';

export async function createTeam(
  ctx: Ctx,
  input: {
    name: string;
    key: string;
    description?: string | null;
    color?: string;
    private?: boolean;
  },
): Promise<string> {
  const [team] = await ctx.tx
    .insert(teams)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      key: input.key,
      description: input.description ?? null,
      color: input.color ?? '#ff1493',
      private: input.private ?? false,
    })
    .returning({ id: teams.id });
  const teamId = team!.id;
  const states = await ctx.tx
    .insert(workflowStates)
    .values(DEFAULT_WORKFLOW_STATES.map((s, i) => ({ ...s, teamId, position: i * SORT_GAP })))
    .returning({ id: workflowStates.id, type: workflowStates.type });
  const backlog = states.find((s) => s.type === 'backlog');
  await ctx.tx
    .update(teams)
    .set({ defaultStateId: backlog?.id ?? null })
    .where(eq(teams.id, teamId));
  // The creator joins as the team's first admin.
  await ctx.tx
    .insert(teamMembers)
    .values({ teamId, userId: ctx.userId, role: 'admin' })
    .onConflictDoNothing();
  emit(ctx, { kind: 'team', action: 'created', id: teamId, teamId });
  return teamId;
}

/** Teams the given access can see, with workflow states and members. */
export async function listTeams(db: DbOrTx, access: Access): Promise<Team[]> {
  const rows = await db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, access.workspaceId), teamScope(access, teams.id)))
    .orderBy(asc(teams.name));
  if (rows.length === 0) return [];
  const ids = rows.map((t) => t.id);
  const [states, members] = await Promise.all([
    db
      .select()
      .from(workflowStates)
      .where(inArray(workflowStates.teamId, ids))
      .orderBy(asc(workflowStates.position)),
    db.select().from(teamMembers).where(inArray(teamMembers.teamId, ids)),
  ]);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    key: t.key,
    description: t.description,
    color: t.color,
    estimateScale: t.estimateScale,
    triageEnabled: t.triageEnabled,
    cyclesEnabled: t.cyclesEnabled,
    defaultStateId: t.defaultStateId,
    private: t.private,
    memberIds: members.filter((m) => m.teamId === t.id).map((m) => m.userId),
    members: members
      .filter((m) => m.teamId === t.id)
      .map((m) => ({ userId: m.userId, role: m.role })),
    states: states
      .filter((s) => s.teamId === t.id)
      .map((s) => ({
        id: s.id,
        teamId: s.teamId,
        name: s.name,
        type: s.type,
        color: s.color,
        position: s.position,
        description: s.description,
      })),
  }));
}
