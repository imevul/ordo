import type { CreateLabelInput, Label } from '@ordo/shared';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { labels, teams } from '../db/schema.ts';
import { badRequest } from '../lib/errors.ts';
import { type Access, assertCan, canReadTeam, teamScope } from './access.ts';
import { type Ctx, emit } from './context.ts';
import { toLabel } from './serialize.ts';

/** Workspace labels, plus labels of teams `access` can read. */
export async function listLabels(db: DbOrTx, access: Access): Promise<Label[]> {
  const rows = await db
    .select()
    .from(labels)
    .where(
      and(
        eq(labels.workspaceId, access.workspaceId),
        access.isAdmin ? undefined : or(isNull(labels.teamId), teamScope(access, labels.teamId)),
      ),
    )
    .orderBy(asc(labels.name));
  return rows.map(toLabel);
}

/** Labels are managed by everyone but guests; team labels only by people who can see the team. */
export async function assertLabelTeam(
  ctx: Ctx,
  teamId: string | null | undefined,
  guestMessage = 'Guests cannot manage labels',
) {
  assertCan(ctx.access, 'labels.create', guestMessage);
  if (!teamId) return;
  const [t] = await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
  if (!t || !canReadTeam(ctx.access, t.id)) throw badRequest('Unknown team');
}

export async function createLabel(ctx: Ctx, input: CreateLabelInput): Promise<Label> {
  await assertLabelTeam(ctx, input.teamId);
  const [row] = await ctx.tx
    .insert(labels)
    .values({ ...input, teamId: input.teamId ?? null, workspaceId: ctx.workspaceId })
    .returning();
  emit(ctx, { kind: 'label', action: 'created', id: row!.id });
  return toLabel(row!);
}
