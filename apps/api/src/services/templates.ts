import type { CreateTemplateInput, IssueTemplate, UpdateTemplateInput } from '@ordo/shared';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { issueTemplates, workspaceMembers } from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { type Access, canReadTeam, teamScope } from './access.ts';
import { type Ctx, emit } from './context.ts';
import { assertAssignee, assertLabels, assertProject, stateOf } from './issues.ts';
import { assertLabelTeam } from './labels.ts';

const toTemplate = (t: typeof issueTemplates.$inferSelect): IssueTemplate => ({
  id: t.id,
  teamId: t.teamId,
  name: t.name,
  title: t.title,
  description: t.description,
  stateId: t.stateId,
  priority: t.priority,
  assigneeId: t.assigneeId,
  projectId: t.projectId,
  estimate: t.estimate,
  labelIds: t.labelIds,
  createdById: t.createdById,
  updatedAt: t.updatedAt,
});

/** Workspace templates, plus templates of teams `access` can read. */
export async function listTemplates(db: DbOrTx, access: Access): Promise<IssueTemplate[]> {
  const rows = await db
    .select()
    .from(issueTemplates)
    .where(
      and(
        eq(issueTemplates.workspaceId, access.workspaceId),
        access.isAdmin
          ? undefined
          : or(isNull(issueTemplates.teamId), teamScope(access, issueTemplates.teamId)),
      ),
    )
    .orderBy(asc(issueTemplates.name));
  return rows.map(toTemplate);
}

async function loadTemplate(ctx: Ctx, id: string) {
  const [row] = await ctx.tx
    .select()
    .from(issueTemplates)
    .where(and(eq(issueTemplates.id, id), eq(issueTemplates.workspaceId, ctx.workspaceId)));
  if (!row || (row.teamId && !canReadTeam(ctx.access, row.teamId))) throw notFound('Template');
  return row;
}

/** What a template sets must make sense where it's used, like on an issue in that team. */
async function assertDefaults(ctx: Ctx, teamId: string | null, t: UpdateTemplateInput) {
  if (t.stateId) {
    if (!teamId) throw badRequest('Only team templates can set a status');
    await stateOf(ctx, teamId, t.stateId);
  }
  if (t.assigneeId) {
    if (teamId) await assertAssignee(ctx, teamId, t.assigneeId);
    else {
      const [m] = await ctx.tx
        .select({ id: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspaceId),
            eq(workspaceMembers.userId, t.assigneeId),
          ),
        );
      if (!m) throw badRequest("Assignee isn't a member of this workspace");
    }
  }
  if (t.projectId) await assertProject(ctx, t.projectId);
  if (t.labelIds) await assertLabels(ctx, teamId, t.labelIds);
}

/** Templates are managed like labels: by everyone but guests, team ones by people in the team. */
export async function createTemplate(ctx: Ctx, input: CreateTemplateInput) {
  const teamId = input.teamId ?? null;
  await assertLabelTeam(ctx, teamId, 'Guests cannot manage templates');
  await assertDefaults(ctx, teamId, input);
  const [row] = await ctx.tx
    .insert(issueTemplates)
    .values({
      ...input,
      teamId,
      labelIds: [...new Set(input.labelIds)],
      workspaceId: ctx.workspaceId,
      createdById: ctx.userId,
    })
    .returning();
  emit(ctx, { kind: 'template', action: 'created', id: row!.id });
  return toTemplate(row!);
}

export async function updateTemplate(ctx: Ctx, id: string, input: UpdateTemplateInput) {
  const current = await loadTemplate(ctx, id);
  await assertLabelTeam(ctx, current.teamId, 'Guests cannot manage templates');
  await assertDefaults(ctx, current.teamId, input);
  const [row] = await ctx.tx
    .update(issueTemplates)
    .set({
      ...input,
      ...(input.labelIds && { labelIds: [...new Set(input.labelIds)] }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(issueTemplates.id, id))
    .returning();
  emit(ctx, { kind: 'template', action: 'updated', id });
  return toTemplate(row!);
}

export async function deleteTemplate(ctx: Ctx, id: string) {
  const current = await loadTemplate(ctx, id);
  await assertLabelTeam(ctx, current.teamId, 'Guests cannot manage templates');
  await ctx.tx.delete(issueTemplates).where(eq(issueTemplates.id, id));
  emit(ctx, { kind: 'template', action: 'deleted', id });
}
