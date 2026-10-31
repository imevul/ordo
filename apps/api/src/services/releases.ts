import {
  type CreateReleaseInput,
  draftReleaseNotes,
  type Issue,
  type Progress,
  type Release,
  type UpdateReleaseInput,
} from '@ordo/shared';
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { issues, labels, releases, teams } from '../db/schema.ts';
import { serverT, userLocale } from '../i18n/index.ts';
import { badRequest, forbidden, notFound, one } from '../lib/errors.ts';
import { type Access, assertTeamAccess, canReadTeam } from './access.ts';
import { type Ctx, emit, record } from './context.ts';
import { bulkUpdateIssues, queryIssues } from './issues.ts';
import { emptyProgress, progressBy } from './progress.ts';

type ReleaseRow = typeof releases.$inferSelect;

export const toRelease = (r: ReleaseRow, progress?: Progress, withNotes = false): Release => ({
  id: r.id,
  teamId: r.teamId,
  name: r.name,
  ...(withNotes && { notes: r.notes }),
  targetDate: r.targetDate,
  releasedAt: r.releasedAt,
  createdById: r.createdBy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  progress: progress ?? emptyProgress(),
});

/** Releases are managed by everyone but guests; a team's release by those who can read the team. */
function assertCanManage(ctx: Ctx, teamId: string | null) {
  if (teamId) assertTeamAccess(ctx.access, teamId);
  if (ctx.access.isGuest) throw forbidden('Guests cannot manage releases').as('guests_releases');
}

/**
 * Releases `access` can see: workspace-wide ones and those of readable teams, unreleased first,
 * then newest out first. Guests only see workspace-wide releases holding one of their issues, so
 * they don't learn the rest of the workspace's plans.
 */
export async function listReleases(db: DbOrTx, access: Access): Promise<Release[]> {
  const [rows, progress] = await Promise.all([
    db
      .select()
      .from(releases)
      .where(eq(releases.workspaceId, access.workspaceId))
      .orderBy(
        sql`${releases.releasedAt} desc nulls first`,
        desc(releases.targetDate),
        desc(releases.createdAt),
      ),
    progressBy(db, 'release_id', access),
  ]);
  return rows
    .filter((r) =>
      r.teamId ? canReadTeam(access, r.teamId) : !access.isGuest || progress.has(r.id),
    )
    .map((r) => toRelease(r, progress.get(r.id)));
}

/** A release of this workspace the caller can see; "not found" otherwise. */
async function findRelease(db: DbOrTx, access: Access, id: string): Promise<ReleaseRow> {
  const [row] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.id, id), eq(releases.workspaceId, access.workspaceId)));
  if (!row || (row.teamId && !canReadTeam(access, row.teamId))) throw notFound('Release');
  return row;
}

/** One release with its notes. */
export async function getRelease(db: DbOrTx, access: Access, id: string): Promise<Release> {
  const row = await findRelease(db, access, id);
  const progress = await progressBy(db, 'release_id', access);
  if (access.isGuest && !row.teamId && !progress.has(id)) throw notFound('Release');
  return toRelease(row, progress.get(id), true);
}

/** A release the caller may manage. */
export async function loadRelease(ctx: Ctx, id: string): Promise<ReleaseRow> {
  const row = await findRelease(ctx.tx, ctx.access, id);
  assertCanManage(ctx, row.teamId);
  return row;
}

async function changed(
  ctx: Ctx,
  row: ReleaseRow,
  action: 'created' | 'updated',
  type: 'release.created' | 'release.updated' | 'release.released' | 'release.reopened',
): Promise<Release> {
  const release = await getRelease(ctx.tx, ctx.access, row.id);
  emit(ctx, { kind: 'release', action, id: row.id, ...(row.teamId && { teamId: row.teamId }) });
  record(ctx, type, release, { teamIds: [row.teamId] });
  return release;
}

export async function createRelease(ctx: Ctx, input: CreateReleaseInput): Promise<Release> {
  const teamId = input.teamId ?? null;
  assertCanManage(ctx, teamId);
  if (teamId) {
    const [team] = await ctx.tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, ctx.workspaceId)));
    if (!team) throw notFound('Team');
  }
  const row = one(
    await ctx.tx
      .insert(releases)
      .values({
        workspaceId: ctx.workspaceId,
        teamId,
        name: input.name,
        notes: input.notes ?? '',
        targetDate: input.targetDate ?? null,
        createdBy: ctx.userId,
      })
      .returning(),
  );
  return changed(ctx, row, 'created', 'release.created');
}

export async function updateRelease(
  ctx: Ctx,
  id: string,
  input: UpdateReleaseInput,
): Promise<Release> {
  await loadRelease(ctx, id);
  const row = one(
    await ctx.tx
      .update(releases)
      .set({ ...input, updatedAt: new Date().toISOString() })
      .where(eq(releases.id, id))
      .returning(),
  );
  return changed(ctx, row, 'updated', 'release.updated');
}

/** Its issues the caller can see, canceled ones left out, in identifier order. */
async function releaseIssues(ctx: Ctx, id: string): Promise<Issue[]> {
  const list = await queryIssues(ctx.tx, ctx.access, {
    releaseIds: [id],
    stateTypes: ['triage', 'backlog', 'unstarted', 'started', 'completed'],
    archived: 'include',
  });
  return list.sort((a, b) =>
    a.identifier.localeCompare(b.identifier, undefined, { numeric: true }),
  );
}

/** Notes drafted from the release's issues, in the caller's language. */
export async function draftNotes(ctx: Ctx, id: string): Promise<string> {
  await loadRelease(ctx, id);
  const [list, labelRows, locale] = await Promise.all([
    releaseIssues(ctx, id),
    ctx.tx
      .select({ id: labels.id, name: labels.name })
      .from(labels)
      .where(eq(labels.workspaceId, ctx.workspaceId)),
    userLocale(ctx.tx, ctx.userId),
  ]);
  return draftReleaseNotes(list, labelRows, serverT(locale)('releases.otherHeading'));
}

/**
 * Puts the release out: freezes its issue list and, unless `draft` is false, drafts notes from
 * the issues when it has none yet.
 */
export async function releaseRelease(
  ctx: Ctx,
  id: string,
  opts: { draft?: boolean } = {},
): Promise<Release> {
  const current = await loadRelease(ctx, id);
  if (current.releasedAt) throw badRequest('That release is already out').as('release_out');
  const notes =
    opts.draft !== false && !current.notes.trim() ? await draftNotes(ctx, id) : current.notes;
  const now = new Date().toISOString();
  const row = one(
    await ctx.tx
      .update(releases)
      .set({ notes, releasedAt: now, updatedAt: now })
      .where(eq(releases.id, id))
      .returning(),
  );
  return changed(ctx, row, 'updated', 'release.released');
}

/** Takes a release back in, so its issue list can change again. */
export async function reopenRelease(ctx: Ctx, id: string): Promise<Release> {
  const current = await loadRelease(ctx, id);
  if (!current.releasedAt) throw badRequest('That release is not out yet').as('release_not_out');
  const row = one(
    await ctx.tx
      .update(releases)
      .set({ releasedAt: null, updatedAt: new Date().toISOString() })
      .where(eq(releases.id, id))
      .returning(),
  );
  return changed(ctx, row, 'updated', 'release.reopened');
}

/** Deletes a release; its issues stay where they are, in no release. */
export async function deleteRelease(ctx: Ctx, id: string) {
  const row = await loadRelease(ctx, id);
  const inRelease = await ctx.tx
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.releaseId, id));
  await bulkUpdateIssues(
    ctx,
    inRelease.map((i) => i.id),
    { releaseId: null },
  );
  await ctx.tx.delete(releases).where(eq(releases.id, id));
  emit(ctx, { kind: 'release', action: 'deleted', id, ...(row.teamId && { teamId: row.teamId }) });
  record(ctx, 'release.deleted', toRelease(row), { teamIds: [row.teamId] });
}

/**
 * Issues the release could take: done, in no release, in its team (any readable team for a
 * workspace-wide one), and completed after the previous release of the same scope went out.
 * Newest first.
 */
export async function releaseSuggestions(
  db: DbOrTx,
  access: Access,
  id: string,
  limit = 500,
): Promise<Issue[]> {
  const release = await findRelease(db, access, id);
  const sameScope = release.teamId ? eq(releases.teamId, release.teamId) : isNull(releases.teamId);
  const [previous] = await db
    .select({ at: sql<string | null>`max(${releases.releasedAt})` })
    .from(releases)
    .where(
      and(
        eq(releases.workspaceId, access.workspaceId),
        sameScope,
        ne(releases.id, id),
        isNotNull(releases.releasedAt),
        // A release that went out after this one was planned still counts as before it.
        release.releasedAt ? sql`${releases.releasedAt} < ${release.releasedAt}` : undefined,
      ),
    );
  const list = await queryIssues(
    db,
    access,
    {
      stateTypes: ['completed'],
      releaseIds: ['none'],
      archived: 'include',
      ...(release.teamId && { teamId: release.teamId }),
    },
    5000,
    'recent',
  );
  const since = previous?.at ? new Date(previous.at).getTime() : null;
  return list
    .filter((i) => since === null || (i.completedAt && new Date(i.completedAt).getTime() > since))
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, limit);
}
