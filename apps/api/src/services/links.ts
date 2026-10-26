import type { IssueLink, IssueLinkKind } from '@ordo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { issueLinks, issues } from '../db/schema.ts';
import { notFound } from '../lib/errors.ts';
import { type Ctx, emit } from './context.ts';

/** Pull requests, branches, commits, chat messages and plain links attached to issues. */

const toLink = (r: typeof issueLinks.$inferSelect): IssueLink => ({
  id: r.id,
  issueId: r.issueId,
  provider: r.provider,
  kind: r.kind,
  url: r.url,
  title: r.title,
  state: r.state,
  author: r.author,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export async function listIssueLinks(db: DbOrTx, issueId: string): Promise<IssueLink[]> {
  const rows = await db
    .select()
    .from(issueLinks)
    .where(eq(issueLinks.issueId, issueId))
    .orderBy(asc(issueLinks.createdAt));
  return rows.map(toLink);
}

export interface LinkInput {
  issueId: string;
  provider: string;
  kind: IssueLinkKind;
  externalId: string;
  url: string;
  title: string;
  state?: string | null;
  author?: string | null;
  authorUserId?: string | null;
  data?: Record<string, unknown>;
  integrationId?: string | null;
}

/** Creates or refreshes a link (unique per issue, provider, kind and external id). */
export async function upsertIssueLink(ctx: Ctx, input: LinkInput): Promise<IssueLink> {
  const [issue] = await ctx.tx
    .select({ teamId: issues.teamId })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.workspaceId, ctx.workspaceId)));
  if (!issue) throw notFound('Issue');
  const values = {
    url: input.url,
    title: input.title.slice(0, 300),
    state: input.state ?? null,
    author: input.author ?? null,
    authorUserId: input.authorUserId ?? null,
    data: input.data ?? {},
    updatedAt: new Date().toISOString(),
  };
  const [row] = await ctx.tx
    .insert(issueLinks)
    .values({
      ...values,
      workspaceId: ctx.workspaceId,
      issueId: input.issueId,
      integrationId: input.integrationId ?? null,
      provider: input.provider,
      kind: input.kind,
      externalId: input.externalId,
      createdById: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [issueLinks.issueId, issueLinks.provider, issueLinks.kind, issueLinks.externalId],
      set: values,
    })
    .returning();
  emit(ctx, { kind: 'issue', action: 'updated', id: input.issueId, teamId: issue.teamId });
  return toLink(row!);
}

export async function deleteIssueLink(ctx: Ctx, id: string, teamIds: (teamId: string) => boolean) {
  const [row] = await ctx.tx
    .select({ link: issueLinks, teamId: issues.teamId })
    .from(issueLinks)
    .innerJoin(issues, eq(issues.id, issueLinks.issueId))
    .where(and(eq(issueLinks.id, id), eq(issueLinks.workspaceId, ctx.workspaceId)));
  if (!row || !teamIds(row.teamId)) throw notFound('Link');
  await ctx.tx.delete(issueLinks).where(eq(issueLinks.id, id));
  emit(ctx, { kind: 'issue', action: 'updated', id: row.link.issueId, teamId: row.teamId });
}
