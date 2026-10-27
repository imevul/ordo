import type { CreateRelationInput } from '@ordo/shared';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { issueRelations, issues, workflowStates } from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { canReadTeam } from './access.ts';
import { type Ctx, emit, record } from './context.ts';
import { getIssue, updateIssue } from './issues.ts';

/**
 * Links two issues the caller can both read. One relation per pair; a new one replaces the old.
 * Imports pass `imported`: their issues already have the status the source gave them.
 */
export async function createRelation(
  ctx: Ctx,
  issueIdOrIdentifier: string,
  input: CreateRelationInput,
  imported = false,
) {
  const issue = await getIssue(ctx.tx, ctx.access, issueIdOrIdentifier);
  const other = await getIssue(ctx.tx, ctx.access, input.relatedIssueId);
  if (issue.id === other.id) throw badRequest('An issue cannot relate to itself').as('relate_self');
  const [from, to] = input.type === 'blocked_by' ? [other, issue] : [issue, other];
  const type =
    input.type === 'blocked_by'
      ? 'blocks'
      : input.type === 'duplicate_of'
        ? 'duplicate'
        : input.type;
  const existing = await ctx.tx
    .select({ id: issueRelations.id })
    .from(issueRelations)
    .where(
      or(
        and(eq(issueRelations.issueId, from.id), eq(issueRelations.relatedIssueId, to.id)),
        and(eq(issueRelations.issueId, to.id), eq(issueRelations.relatedIssueId, from.id)),
      ),
    );
  if (existing.length) {
    await ctx.tx.delete(issueRelations).where(
      inArray(
        issueRelations.id,
        existing.map((e) => e.id),
      ),
    );
  }
  const [row] = await ctx.tx
    .insert(issueRelations)
    .values({ issueId: from.id, relatedIssueId: to.id, type, createdBy: ctx.userId })
    .returning();
  // Marking a duplicate closes it, like Linear does.
  if (type === 'duplicate' && !imported) {
    const states = await ctx.tx
      .select()
      .from(workflowStates)
      .where(and(eq(workflowStates.teamId, issue.teamId), eq(workflowStates.type, 'canceled')))
      .orderBy(asc(workflowStates.position));
    const target = states.find((s) => s.name.toLowerCase() === 'duplicate') ?? states[0];
    if (target && target.id !== issue.stateId)
      await updateIssue(ctx, issue.id, { stateId: target.id });
  }
  emit(ctx, { kind: 'issue', action: 'updated', id: issue.id, teamId: issue.teamId });
  emit(ctx, { kind: 'issue', action: 'updated', id: other.id, teamId: other.teamId });
  record(
    ctx,
    'relation.created',
    { id: row!.id, type, issueId: row!.issueId, relatedIssueId: row!.relatedIssueId },
    { teamIds: [issue.teamId, other.teamId] },
  );
  return row!;
}

/** Removes a relation; the caller must be able to read both issues. */
export async function deleteRelation(ctx: Ctx, id: string) {
  const [rel] = await ctx.tx.select().from(issueRelations).where(eq(issueRelations.id, id));
  if (!rel) throw notFound('Relation');
  const ends = await ctx.tx
    .select({ id: issues.id, teamId: issues.teamId, workspaceId: issues.workspaceId })
    .from(issues)
    .where(inArray(issues.id, [rel.issueId, rel.relatedIssueId]));
  if (
    ends.length !== 2 ||
    ends.some((e) => e.workspaceId !== ctx.workspaceId || !canReadTeam(ctx.access, e.teamId))
  ) {
    throw notFound('Relation');
  }
  await ctx.tx.delete(issueRelations).where(eq(issueRelations.id, id));
  for (const end of ends)
    emit(ctx, { kind: 'issue', action: 'updated', id: end.id, teamId: end.teamId });
  record(
    ctx,
    'relation.deleted',
    { id, type: rel.type, issueId: rel.issueId, relatedIssueId: rel.relatedIssueId },
    { teamIds: ends.map((e) => e.teamId) },
  );
}
