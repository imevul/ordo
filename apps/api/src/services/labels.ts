import type { CreateLabelInput, Label } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import { labels, teams } from '../db/schema.ts';
import { badRequest } from '../lib/errors.ts';
import { assertCan, canReadTeam } from './access.ts';
import { type Ctx, emit } from './context.ts';
import { toLabel } from './serialize.ts';

/** Labels are managed by everyone but guests; team labels only by people who can see the team. */
export async function assertLabelTeam(ctx: Ctx, teamId: string | null | undefined) {
  assertCan(ctx.access, 'labels.create', 'Guests cannot manage labels');
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
