import type { CreateInitiativeInput, Initiative, Progress, Project } from '@ordo/shared';
import { and, asc, eq, min } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { initiatives } from '../db/schema.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { type Access, assertCan } from './access.ts';
import { type Ctx, emit, record } from './context.ts';
import { emptyProgress } from './progress.ts';
import { assertProjectLead, listProjects } from './projects.ts';

const sum = (list: Progress[]) =>
  list.reduce((acc, p) => {
    for (const k of Object.keys(acc) as (keyof Progress)[]) acc[k] += p[k];
    return acc;
  }, emptyProgress());

/**
 * Initiatives with the projects `access` can see in them. Guests only see initiatives that have
 * one of their projects, so a guest doesn't learn about the rest of the workspace's plans.
 */
export async function listInitiatives(
  db: DbOrTx,
  access: Access,
  visibleProjects?: Project[],
): Promise<Initiative[]> {
  const projects = visibleProjects ?? (await listProjects(db, access));
  const rows = await db
    .select()
    .from(initiatives)
    .where(eq(initiatives.workspaceId, access.workspaceId))
    .orderBy(asc(initiatives.sortOrder), asc(initiatives.createdAt));
  return rows
    .map((i) => {
      const mine = projects.filter((p) => p.initiativeId === i.id);
      return {
        id: i.id,
        name: i.name,
        description: i.description,
        status: i.status,
        ownerId: i.ownerId,
        targetDate: i.targetDate,
        color: i.color,
        sortOrder: i.sortOrder,
        projectIds: mine.map((p) => p.id),
        progress: sum(mine.map((p) => p.progress)),
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      };
    })
    .filter((i) => !access.isGuest || i.projectIds.length > 0);
}

/** Initiatives are managed by everyone but guests, like projects. */
async function loadInitiative(ctx: Ctx, id: string) {
  assertCan(ctx.access, 'projects.create', 'Guests cannot manage initiatives');
  const [row] = await ctx.tx
    .select()
    .from(initiatives)
    .where(and(eq(initiatives.id, id), eq(initiatives.workspaceId, ctx.workspaceId)));
  if (!row) throw notFound('Initiative');
  return row;
}

/** That an initiative a project is being put in exists in this workspace. */
export async function assertInitiative(ctx: Ctx, id: string | null | undefined) {
  if (!id) return;
  const [row] = await ctx.tx
    .select({ id: initiatives.id })
    .from(initiatives)
    .where(and(eq(initiatives.id, id), eq(initiatives.workspaceId, ctx.workspaceId)));
  if (!row) throw badRequest('Unknown initiative');
}

async function changed(ctx: Ctx, id: string, type: 'initiative.created' | 'initiative.updated') {
  const [initiative] = (await listInitiatives(ctx.tx, ctx.access)).filter((i) => i.id === id);
  const projects = await listProjects(ctx.tx, ctx.access);
  const teamIds = projects.filter((p) => p.initiativeId === id).flatMap((p) => p.teamIds);
  emit(ctx, {
    kind: 'initiative',
    action: type === 'initiative.created' ? 'created' : 'updated',
    id,
  });
  record(ctx, type, initiative!, { teamIds });
  return initiative!;
}

export async function createInitiative(ctx: Ctx, input: CreateInitiativeInput) {
  assertCan(ctx.access, 'projects.create', 'Guests cannot manage initiatives');
  await assertProjectLead(ctx, input.ownerId);
  const [{ first }] = (await ctx.tx
    .select({ first: min(initiatives.sortOrder) })
    .from(initiatives)
    .where(eq(initiatives.workspaceId, ctx.workspaceId))) as [{ first: number | null }];
  const [row] = await ctx.tx
    .insert(initiatives)
    .values({
      ...input,
      workspaceId: ctx.workspaceId,
      createdBy: ctx.userId,
      sortOrder: (first ?? 0) - 1024,
    })
    .returning({ id: initiatives.id });
  return changed(ctx, row!.id, 'initiative.created');
}

export async function updateInitiative(
  ctx: Ctx,
  id: string,
  input: Partial<CreateInitiativeInput> & { sortOrder?: number },
) {
  await loadInitiative(ctx, id);
  if (input.ownerId) await assertProjectLead(ctx, input.ownerId);
  await ctx.tx
    .update(initiatives)
    .set({ ...input, updatedAt: new Date().toISOString() })
    .where(eq(initiatives.id, id));
  return changed(ctx, id, 'initiative.updated');
}

/** Deletes an initiative; its projects stay, outside any initiative. */
export async function deleteInitiative(ctx: Ctx, id: string) {
  const row = await loadInitiative(ctx, id);
  await ctx.tx.delete(initiatives).where(eq(initiatives.id, id));
  emit(ctx, { kind: 'initiative', action: 'deleted', id });
  emit(ctx, { kind: 'project', action: 'updated', id });
  record(ctx, 'initiative.deleted', { id, name: row.name });
}
