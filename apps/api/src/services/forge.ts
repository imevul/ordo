import {
  type ForgeRepository,
  type GitEvent,
  gitAutomationTarget,
  type PullRequestChecks,
  type PullRequestReview,
  STATE_TYPES,
} from '@ordo/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  externalAccounts,
  issueLinks,
  issues,
  teamKeyAliases,
  teams,
  workflowStates,
  workspaces,
} from '../db/schema.ts';
import type { IntegrationContext } from '../integrations/types.ts';
import type { Ctx } from './context.ts';
import { updateIssue } from './issues.ts';
import { type PullRequestData, upsertIssueLink } from './links.ts';
import { issueForPullRequest, onPullRequestChange, tagQueuedRun } from './pullRequests.ts';

/**
 * What GitHub, GitLab and Forgejo have in common. Providers turn their payloads into
 * `ForgePullRequest` / `ForgeCommit` / `ForgeBranch` and hand them here, so linking, magic words
 * and status automation behave the same everywhere.
 *
 * - An identifier in a branch name or PR title links the PR and lets it move the issue.
 * - In a PR description or commit message, "fixes / closes / resolves ENG-42" does the same;
 *   "refs / part of / related to ENG-42" only links. Bare mentions in descriptions are ignored.
 * - Issues only ever move forward (Backlog → In Progress → In Review → Done), never back.
 */

export type PullRequestState = 'draft' | 'open' | 'review' | 'merged' | 'closed';

export interface ForgeUser {
  id: string;
  login: string;
}

export interface ForgePullRequest {
  /** owner/name or group/project */
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  branch: string;
  state: PullRequestState;
  author: ForgeUser | null;
  /** Head commit sha; checks are about it. */
  head?: string;
  /** Left out when the event doesn't say: what an earlier one told us stays. */
  checks?: PullRequestChecks | null;
  review?: PullRequestReview | null;
  /** The event is a review being submitted (so "changes requested" is news). */
  reviewed?: boolean;
}

export interface ForgeCommit {
  sha: string;
  message: string;
  url: string;
  author: string | null;
}

export interface ForgeBranch {
  repo: string;
  name: string;
  url: string;
}

const ID = String.raw`([A-Za-z][A-Za-z0-9]{0,6})-(\d+)`;
const CLOSING = `(?:close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving|complete[sd]?|completing)`;
const REFERENCING = String.raw`(?:refs?|references?|part\s+of|related\s+to|contributes\s+to|towards)`;
// "Fixes ENG-1, ENG-2 and ENG-3" — a magic word applies to the whole list after it.
const LIST = String.raw`((?:\s*[,:]?\s*(?:and\s+)?${ID.replace(/\(/g, '(?:')})+)`;

const idsIn = (text: string) =>
  [...text.matchAll(new RegExp(`(?<![A-Za-z0-9])${ID}(?![A-Za-z0-9])`, 'g'))].map(
    (m) => `${m[1]!.toUpperCase()}-${Number(m[2])}`,
  );

function magic(text: string, words: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(new RegExp(String.raw`\b${words}\b${LIST}`, 'gi'))) {
    for (const id of idsIn(m[1]!)) out.add(id);
  }
  return out;
}

/** Identifiers that may move issues (`closing`) and ones that only link (`referenced`). */
export function parseReferences(parts: { branch?: string; title?: string; body?: string }) {
  const closing = new Set([
    ...idsIn(parts.branch ?? ''),
    ...idsIn(parts.title ?? ''),
    ...magic(parts.body ?? '', CLOSING),
  ]);
  const referenced = new Set(
    [...magic(parts.body ?? '', REFERENCING)].filter((id) => !closing.has(id)),
  );
  return { closing, referenced };
}

/** Commits: any identifier links; with a closing word, it may also move the issue. */
export function parseCommit(message: string) {
  const closing = magic(message, CLOSING);
  const referenced = new Set(idsIn(message).filter((id) => !closing.has(id)));
  return { closing, referenced };
}

interface ResolvedIssue {
  id: string;
  teamId: string;
  stateId: string;
}

/** Identifiers → issues in the workspace, through current team keys and former ones. */
export async function resolveIdentifiers(ctx: Ctx, identifiers: Iterable<string>) {
  const wanted = [...new Set(identifiers)];
  const out = new Map<string, ResolvedIssue>();
  if (!wanted.length) return out;
  const keys = [...new Set(wanted.map((i) => i.split('-')[0]!))];
  const current = await ctx.tx
    .select({ id: teams.id, key: teams.key })
    .from(teams)
    .where(and(eq(teams.workspaceId, ctx.workspaceId), inArray(teams.key, keys)));
  const former = await ctx.tx
    .select({ id: teamKeyAliases.teamId, key: teamKeyAliases.key })
    .from(teamKeyAliases)
    .where(and(eq(teamKeyAliases.workspaceId, ctx.workspaceId), inArray(teamKeyAliases.key, keys)));
  const teamByKey = new Map([...former, ...current].map((t) => [t.key, t.id]));
  for (const identifier of wanted) {
    const [key, n] = identifier.split('-');
    const teamId = teamByKey.get(key!);
    if (!teamId) continue;
    const [row] = await ctx.tx
      .select({ id: issues.id, teamId: issues.teamId, stateId: issues.stateId })
      .from(issues)
      .where(
        and(
          eq(issues.teamId, teamId),
          eq(issues.number, Number(n)),
          sql`${issues.deletedAt} is null`,
        ),
      );
    if (row) out.set(identifier, row);
  }
  return out;
}

const rank = (s: { type: string; position: number }) =>
  STATE_TYPES.indexOf(s.type as never) * 10_000 + s.position;

/** Moves an issue to the team's status for `event`, if that's further along than where it is. */
export async function automate(ctx: Ctx, issue: ResolvedIssue, event: GitEvent) {
  const [team] = await ctx.tx
    .select({ automation: teams.gitAutomation })
    .from(teams)
    .where(eq(teams.id, issue.teamId));
  const states = await ctx.tx
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.teamId, issue.teamId));
  const target = gitAutomationTarget(team?.automation, states, event);
  const current = states.find((s) => s.id === issue.stateId);
  const next = states.find((s) => s.id === target);
  if (!next || !current || next.id === current.id) return false;
  // Never backwards, and never out of a canceled state.
  if (current.type === 'canceled' || rank(next) <= rank(current)) return false;
  await updateIssue(ctx, issue.id, { stateId: next.id });
  return true;
}

/** The Ordo user behind a forge account, if someone claimed it (Account → Connected accounts). */
export async function userFor(
  ctx: Ctx,
  provider: string,
  host: string,
  user: ForgeUser | string | null,
) {
  if (!user) return null;
  const login = (typeof user === 'string' ? user : user.login).toLowerCase();
  const [row] = await ctx.tx
    .select({ userId: externalAccounts.userId })
    .from(externalAccounts)
    .where(
      and(
        eq(externalAccounts.workspaceId, ctx.workspaceId),
        eq(externalAccounts.provider, provider),
        eq(externalAccounts.host, host),
        eq(externalAccounts.externalId, login),
      ),
    );
  return row?.userId ?? null;
}

const prEvent = (state: PullRequestState): GitEvent | null => (state === 'closed' ? null : state);

/**
 * Links a pull request to the issues it mentions and to those it was linked to before, and moves
 * them along. Returns the issues it's linked to, and whether each link is new.
 */
export async function applyPullRequest(
  ictx: IntegrationContext,
  host: string,
  pr: ForgePullRequest,
) {
  const { provider } = ictx.integration;
  const externalId = `${pr.repo}#${pr.number}`;
  return ictx.run(async (ctx) => {
    // Deliveries for one PR (opened, review_requested…) arrive together; one at a time, so an
    // issue made for an unlinked PR is made once.
    await ctx.tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${ctx.workspaceId}:${provider}:${externalId}`}))`,
    );
    const { closing, referenced } = parseReferences(pr);
    const found = await resolveIdentifiers(ctx, [...closing, ...referenced]);
    const existing = await ctx.tx
      .select({ link: issueLinks, teamId: issues.teamId, stateId: issues.stateId })
      .from(issueLinks)
      .innerJoin(issues, eq(issues.id, issueLinks.issueId))
      .where(
        and(
          eq(issueLinks.workspaceId, ctx.workspaceId),
          eq(issueLinks.provider, provider),
          eq(issueLinks.kind, 'pull_request'),
          eq(issueLinks.externalId, externalId),
          isNull(issues.deletedAt),
        ),
      );
    const targets = new Map<string, { issue: ResolvedIssue; closes: boolean }>();
    for (const [identifier, issue] of found)
      targets.set(issue.id, { issue, closes: closing.has(identifier) });
    // Once linked, a PR stays linked even if its title stops naming the issue.
    for (const e of existing)
      if (!targets.has(e.link.issueId))
        targets.set(e.link.issueId, {
          issue: { id: e.link.issueId, teamId: e.teamId, stateId: e.stateId },
          closes: !!(e.link.data as Partial<PullRequestData>).closes,
        });
    let handedOffTo: string | undefined;
    if (!targets.size) {
      const made = await issueForPullRequest(ctx, ictx, pr);
      if (made) {
        handedOffTo = made.agentId;
        targets.set(made.issue.id, { issue: made.issue, closes: true });
      }
    }
    const authorUserId = pr.author ? await userFor(ctx, provider, host, pr.author) : undefined;
    const linked: { issueId: string; created: boolean }[] = [];
    for (const { issue, closes } of targets.values()) {
      const prev = existing.find((e) => e.link.issueId === issue.id)?.link;
      const before = (prev?.data ?? {}) as Partial<PullRequestData>;
      const newHead = !!(pr.head && before.head && pr.head !== before.head);
      const data: PullRequestData = {
        ...before,
        repo: pr.repo,
        number: pr.number,
        branch: pr.branch,
        head: pr.head ?? before.head,
        // Checks belong to a commit; a new head hasn't got any yet.
        checks: pr.checks !== undefined ? pr.checks : newHead ? null : (before.checks ?? null),
        review: pr.review !== undefined ? pr.review : (before.review ?? null),
        closes: closes || !!before.closes,
        ...(handedOffTo && { handedOffTo }),
      };
      const link = await upsertIssueLink(ctx, {
        issueId: issue.id,
        provider,
        kind: 'pull_request',
        externalId,
        url: pr.url,
        title: `${pr.title} (${externalId})`,
        state: pr.state,
        author: pr.author?.login,
        authorUserId,
        data: { ...data },
        integrationId: ictx.integration.id,
      });
      linked.push({ issueId: issue.id, created: !prev });
      const event = prEvent(pr.state);
      if (event && data.closes) await automate(ctx, issue, event);
      if (handedOffTo) {
        await tagQueuedRun(ctx, issue.id, handedOffTo, {
          event: 'ready_for_review',
          repo: pr.repo,
          number: pr.number,
          url: pr.url,
          branch: pr.branch,
        });
        continue;
      }
      await onPullRequestChange(ctx, ictx, {
        issueId: issue.id,
        linkId: link.id,
        url: pr.url,
        data,
        state: pr.state,
        prevState: prev?.state ?? null,
        prevChecks: before.checks ?? null,
        reviewed: pr.reviewed,
      });
    }
    return linked;
  });
}

/**
 * Checks finished or started on a commit: updates the pull requests whose head it is. Found by
 * `repo#number` when the forge says, else by head sha (pull requests from forks).
 */
export async function applyPullRequestChecks(
  ictx: IntegrationContext,
  update: { sha: string; checks: PullRequestChecks | null; repo?: string; numbers?: number[] },
) {
  const { provider } = ictx.integration;
  await ictx.run(async (ctx) => {
    const byNumber = update.repo && update.numbers?.length;
    const rows = await ctx.tx
      .select({ link: issueLinks, teamId: issues.teamId })
      .from(issueLinks)
      .innerJoin(issues, eq(issues.id, issueLinks.issueId))
      .where(
        and(
          eq(issueLinks.workspaceId, ctx.workspaceId),
          eq(issueLinks.provider, provider),
          eq(issueLinks.kind, 'pull_request'),
          isNull(issues.deletedAt),
          byNumber
            ? inArray(
                issueLinks.externalId,
                update.numbers!.map((n) => `${update.repo}#${n}`),
              )
            : sql`${issueLinks.data}->>'head' = ${update.sha}`,
        ),
      );
    for (const { link } of rows) {
      const before = link.data as unknown as PullRequestData;
      // Results for a commit the PR has moved past say nothing about it.
      if (before.head && before.head !== update.sha) continue;
      if ((before.checks ?? null) === update.checks) continue;
      const data: PullRequestData = { ...before, head: update.sha, checks: update.checks };
      await upsertIssueLink(ctx, {
        issueId: link.issueId,
        provider,
        kind: 'pull_request',
        externalId: link.externalId,
        url: link.url,
        title: link.title,
        state: link.state,
        data: { ...data },
        integrationId: link.integrationId,
      });
      await onPullRequestChange(ctx, ictx, {
        issueId: link.issueId,
        linkId: link.id,
        url: link.url,
        data,
        state: link.state,
        prevState: link.state,
        prevChecks: before.checks ?? null,
      });
    }
  });
}

/** Sums up check results: anything failed → failing, anything unfinished → pending. */
export function summarizeChecks(
  results: ('success' | 'failure' | 'pending' | 'neutral' | 'skipped')[],
): PullRequestChecks | null {
  if (!results.length) return null;
  if (results.includes('failure')) return 'failing';
  if (results.includes('pending')) return 'pending';
  return 'passing';
}

/** Links commits that mention issues; on the default branch, closing words move issues to done. */
export async function applyCommits(
  ictx: IntegrationContext,
  repo: string,
  commits: ForgeCommit[],
  onDefaultBranch: boolean,
) {
  const { provider } = ictx.integration;
  await ictx.run(async (ctx) => {
    for (const commit of commits) {
      const { closing, referenced } = parseCommit(commit.message);
      const found = await resolveIdentifiers(ctx, [...closing, ...referenced]);
      for (const [identifier, issue] of found) {
        await upsertIssueLink(ctx, {
          issueId: issue.id,
          provider,
          kind: 'commit',
          externalId: commit.sha,
          url: commit.url,
          title: `${commit.message.split('\n')[0]!.slice(0, 200)} (${commit.sha.slice(0, 7)})`,
          author: commit.author,
          data: { repo },
          integrationId: ictx.integration.id,
        });
        if (onDefaultBranch && closing.has(identifier)) await automate(ctx, issue, 'merged');
      }
    }
  });
}

/** A pushed branch whose name mentions issues. */
export async function applyBranch(ictx: IntegrationContext, branch: ForgeBranch) {
  const { provider } = ictx.integration;
  await ictx.run(async (ctx) => {
    const found = await resolveIdentifiers(ctx, idsIn(branch.name));
    for (const issue of found.values()) {
      await upsertIssueLink(ctx, {
        issueId: issue.id,
        provider,
        kind: 'branch',
        externalId: `${branch.repo}:${branch.name}`,
        url: branch.url,
        title: `${branch.name} (${branch.repo})`,
        data: { repo: branch.repo },
        integrationId: ictx.integration.id,
      });
      await automate(ctx, issue, 'branch');
    }
  });
}

/** How GitHub and Forgejo both describe a repository. */
export interface ForgeRepoPayload {
  full_name: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  private: boolean;
}

// Enough for any sensible account; beyond that, people search.
const MAX_REPO_PAGES = 10;

/**
 * Walks a paginated repository listing (`fetchPage(1)`, `fetchPage(2)`…) until a short page
 * (or, with `pageSize` null, an empty one), keeping the repositories whose owner/name contains
 * `query`, sorted by name.
 */
export async function collectRepositories(
  pageSize: number | null,
  fetchPage: (page: number) => Promise<ForgeRepoPayload[]>,
  query?: string,
): Promise<ForgeRepository[]> {
  const needle = query?.trim().toLowerCase();
  const out: ForgeRepository[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const batch = await fetchPage(page);
    for (const r of batch) {
      if (needle && !r.full_name.toLowerCase().includes(needle)) continue;
      out.push({
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        sshUrl: r.ssh_url,
        defaultBranch: r.default_branch || 'main',
        private: !!r.private,
      });
    }
    if (batch.length === 0 || (pageSize !== null && batch.length < pageSize)) break;
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** True for branch names and messages worth looking at (cheap pre-filter). */
export const mentionsIssue = (text: string) => idsIn(text).length > 0;

/** Identifier, title and Ordo URL of issues, for comments posted back to the forge. */
export async function issueSummaries(ictx: IntegrationContext, issueIds: string[]) {
  if (!issueIds.length) return [];
  const rows = await ictx.app.db
    .select({ number: issues.number, title: issues.title, key: teams.key, slug: workspaces.slug })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .innerJoin(workspaces, eq(workspaces.id, issues.workspaceId))
    .where(inArray(issues.id, issueIds));
  return rows.map((r) => ({
    identifier: `${r.key}-${r.number}`,
    title: r.title,
    url: `${ictx.app.env.publicUrl}/${r.slug}/issue/${r.key}-${r.number}`,
  }));
}

/** The Markdown comment posted on a PR when it gets linked. */
export const linkedComment = (list: { identifier: string; title: string; url: string }[]) =>
  list.map((i) => `[${i.identifier} ${i.title.replace(/[[\]]/g, '')}](${i.url})`).join('\n');
