import type { IssueLink, IssueLinkKind, PullRequestChecks, PullRequestReview } from '@ordo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { issueLinks, issues } from '../db/schema.ts';
import { notFound } from '../lib/errors.ts';
import { type Ctx, emit } from './context.ts';

/** Pull requests, branches, commits, chat messages and plain links attached to issues. */

/** What `issue_links.data` holds for a pull request (see services/forge.ts). */
export interface PullRequestData {
  repo: string;
  number: number;
  branch: string;
  /** Head commit; checks belong to it. */
  head?: string;
  checks?: PullRequestChecks | null;
  review?: PullRequestReview | null;
  /** Linked by a closing reference (or created for it), so its events move the issue. */
  closes?: boolean;
  /** The project's pull request agent it was handed to, once. */
  handedOffTo?: string;
  /** The run after which follow-ups stopped (services/pullRequests.ts), so that's said once. */
  stoppedAfter?: string;
}

const toLink = (r: typeof issueLinks.$inferSelect): IssueLink => {
  const pr = r.kind === 'pull_request' ? (r.data as Partial<PullRequestData> | null) : null;
  return {
    id: r.id,
    issueId: r.issueId,
    provider: r.provider,
    kind: r.kind,
    url: r.url,
    title: r.title,
    state: r.state,
    author: r.author,
    ...(pr?.repo &&
      pr.number !== undefined && {
        pullRequest: {
          repo: pr.repo,
          number: pr.number,
          branch: pr.branch ?? '',
          checks: pr.checks ?? null,
          review: pr.review ?? null,
        },
      }),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
};

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
    // Unknown authors (undefined) keep what an earlier event told us.
    ...(input.author !== undefined && { author: input.author }),
    ...(input.authorUserId !== undefined && { authorUserId: input.authorUserId }),
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
  emit(ctx, {
    kind: 'issue',
    action: 'updated',
    id: input.issueId,
    teamId: issue.teamId,
    bootstrapUnchanged: true,
  });
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
  emit(ctx, {
    kind: 'issue',
    action: 'updated',
    id: row.link.issueId,
    teamId: row.teamId,
    bootstrapUnchanged: true,
  });
}
