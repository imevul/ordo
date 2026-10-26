import type { ImportSummary, StateType } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { ApiCallError, callApi, trimUrl } from '../../integrations/http.ts';
import { importSecrets } from './secrets.ts';
import {
  ImportAbort,
  type ImportAdapter,
  ImportRetryLater,
  type Page,
  type SourceContext,
  type SourceIssue,
} from './types.ts';

/**
 * GitHub Issues, read through the REST API with a token, from one or more repositories (on
 * GitHub Enterprise Server too). Each repository is a source team; milestones become projects;
 * pull requests are left out. People are GitHub logins, matched to usernames members claimed.
 */

const DEFAULT_API = 'https://api.github.com';
const PER_PAGE = 100;

interface GithubConfig {
  repos: string[];
  apiUrl: string;
}

const cfg = (sctx: SourceContext) => sctx.row.config as unknown as GithubConfig;

/** The host logins belong to, as claimed under Connected accounts: github.com or the server's. */
const webHost = (apiUrl: string) => {
  const host = new URL(apiUrl).host;
  return host === 'api.github.com' ? 'github.com' : host;
};

async function gh<T>(app: FastifyInstance, apiUrl: string, token: string, path: string) {
  try {
    const res = await callApi<T>(app, `${apiUrl}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      timeoutMs: 30_000,
    });
    return { data: res.data, more: /rel="next"/.test(res.headers.get('link') ?? '') };
  } catch (err) {
    if (err instanceof ApiCallError) {
      // GitHub says 403 "API rate limit exceeded" (or 429 for secondary limits).
      if (err.status === 429 || /rate limit/i.test(err.message)) {
        throw new ImportRetryLater(
          "Waiting for GitHub's rate limit; the import carries on by itself",
          new Date(Date.now() + 10 * 60_000),
        );
      }
      if (err.status === 401) {
        throw new ImportAbort('GitHub refused the token: check it and start a new import');
      }
    }
    throw err;
  }
}

const call = <T>(sctx: SourceContext, path: string) =>
  gh<T>(sctx.app, cfg(sctx).apiUrl, importSecrets<{ token: string }>(sctx).token, path);

async function allPages<T>(sctx: SourceContext, path: string) {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const { data, more } = await call<T[]>(sctx, `${path}&page=${page}`);
    out.push(...data);
    if (!more) return out;
  }
}

/** A page of something listed per repository, going through the repositories in turn. */
async function across<T, R>(
  sctx: SourceContext,
  cursor: string | null,
  path: (repo: string) => string,
  map: (repo: string, item: T) => R | null,
): Promise<Page<R>> {
  const { repos } = cfg(sctx);
  const [repoIndex, page] = cursor ? cursor.split(':').map(Number) : [0, 1];
  const repo = repos[repoIndex!]!;
  const { data, more } = await call<T[]>(sctx, `${path(repo)}&page=${page}`);
  return {
    items: data.map((item) => map(repo, item)).filter((x): x is R => x !== null),
    next: more
      ? `${repoIndex}:${page! + 1}`
      : repoIndex! + 1 < repos.length
        ? `${repoIndex! + 1}:1`
        : null,
  };
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason: string | null;
  user: { login: string } | null;
  assignee: { login: string } | null;
  labels: ({ name: string } | string)[];
  milestone: { number: number } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  pull_request?: unknown;
}

const STATUSES: Record<string, StateType> = {
  Open: 'unstarted',
  Closed: 'completed',
  'Closed as not planned': 'canceled',
  'Closed as duplicate': 'canceled',
};

function statusOf(i: GhIssue) {
  if (i.state === 'open') return 'Open';
  if (i.state_reason === 'not_planned') return 'Closed as not planned';
  if (i.state_reason === 'duplicate') return 'Closed as duplicate';
  return 'Closed';
}

const issuesPath = (repo: string) =>
  `/repos/${repo}/issues?state=all&sort=created&direction=asc&per_page=${PER_PAGE}`;
const login = (u: { login: string } | null) => u?.login.toLowerCase();
const labelKey = (name: string) => `label:${name.trim().toLowerCase()}`;
const labelName = (l: { name: string } | string) => (typeof l === 'string' ? l : l.name);
const milestoneId = (repo: string, number: number) => `${repo}#m${number}`;

function toIssue(repo: string, i: GhIssue): SourceIssue | null {
  if (i.pull_request) return null;
  const status = statusOf(i);
  const closed = i.closed_at ?? undefined;
  const canceled = STATUSES[status] === 'canceled';
  return {
    id: `${repo}#${i.number}`,
    ref: `${repo}#${i.number}`,
    teamId: repo,
    number: i.number,
    title: i.title,
    description: i.body ?? undefined,
    status,
    assigneeId: login(i.assignee),
    creatorId: login(i.user),
    labelIds: [...new Set(i.labels.map((l) => labelKey(labelName(l))))],
    projectId: i.milestone ? milestoneId(repo, i.milestone.number) : undefined,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    completedAt: i.state === 'closed' && !canceled ? closed : undefined,
    canceledAt: canceled ? closed : undefined,
    url: i.html_url,
  };
}

export const githubSource: ImportAdapter = {
  key: 'github',

  async start(app, input) {
    if (input.source !== 'github') throw new Error('Not a GitHub import');
    const apiUrl = trimUrl(input.apiUrl ?? DEFAULT_API);
    const repos: string[] = [];
    for (const repo of new Set(input.repos)) {
      try {
        const { data } = await gh<{ full_name: string }>(
          app,
          apiUrl,
          input.token,
          `/repos/${repo}`,
        );
        repos.push(data.full_name);
      } catch (err) {
        if (err instanceof ApiCallError && err.status === 404) {
          throw new ImportAbort(`Can't see ${repo} with this token`);
        }
        throw err;
      }
    }
    return {
      name: `GitHub: ${repos[0]}${repos.length > 1 ? ` and ${repos.length - 1} more` : ''}`,
      config: { repos, apiUrl },
      secrets: { token: input.token },
    };
  },

  async analyze(sctx) {
    const { repos, apiUrl } = cfg(sctx);
    const host = webHost(apiUrl);
    const users = new Map<string, number>();
    const labels = new Map<string, { name: string; count: number }>();
    const summary: ImportSummary = {
      teams: [],
      users: [],
      labels: [],
      projects: [],
      counts: { issues: 0, comments: 0 },
      warnings: [],
    };
    const count = (user: string | undefined) => {
      if (user) users.set(user, (users.get(user) ?? 0) + 1);
    };

    for (const repo of repos) {
      for (const l of await allPages<{ name: string }>(
        sctx,
        `/repos/${repo}/labels?per_page=${PER_PAGE}`,
      )) {
        const id = labelKey(l.name);
        if (!labels.has(id)) labels.set(id, { name: l.name, count: 0 });
      }
      const milestones = await allPages<{
        number: number;
        title: string;
        description: string | null;
        state: 'open' | 'closed';
        due_on: string | null;
      }>(sctx, `/repos/${repo}/milestones?state=all&per_page=${PER_PAGE}`);
      const perMilestone = new Map<number, number>();
      const statuses = new Map<string, number>([
        ['Open', 0],
        ['Closed', 0],
      ]);
      let issueCount = 0;
      const numbers = new Set<number>();
      for (const i of await allPages<GhIssue>(sctx, issuesPath(repo))) {
        if (i.pull_request) continue;
        issueCount++;
        numbers.add(i.number);
        summary.counts.comments += i.comments;
        const status = statusOf(i);
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
        count(login(i.assignee));
        count(login(i.user));
        for (const l of i.labels) {
          const label = labels.get(labelKey(labelName(l)));
          if (label) label.count++;
        }
        if (i.milestone) {
          perMilestone.set(i.milestone.number, (perMilestone.get(i.milestone.number) ?? 0) + 1);
        }
      }
      // Commenters can be people who never opened or took an issue; they need mapping too.
      for (const c of await allPages<{ user: { login: string } | null; issue_url: string }>(
        sctx,
        `/repos/${repo}/issues/comments?per_page=${PER_PAGE}`,
      )) {
        const number = Number(/\/issues\/(\d+)$/.exec(c.issue_url)?.[1]);
        if (numbers.has(number)) count(login(c.user));
      }
      summary.counts.issues += issueCount;
      summary.teams.push({
        id: repo,
        name: repo.split('/')[1]!,
        key: null,
        issueCount,
        statuses: [...statuses].map(([name, n]) => ({ name, type: STATUSES[name]!, count: n })),
      });
      for (const m of milestones) {
        summary.projects.push({
          id: milestoneId(repo, m.number),
          name: m.title,
          count: perMilestone.get(m.number) ?? 0,
          teamIds: [repo],
          description: m.description,
          status: m.state === 'open' ? 'planned' : 'completed',
          targetDate: m.due_on?.slice(0, 10) ?? null,
        });
      }
    }

    summary.users = [...users].map(([id, n]) => ({
      id,
      name: id,
      email: null,
      count: n,
      account: { provider: 'github', host, login: id },
    }));
    summary.labels = [...labels].map(([id, l]) => ({ id, ...l }));
    return { summary };
  },

  issues: (sctx, cursor) => across<GhIssue, SourceIssue>(sctx, cursor, issuesPath, toIssue),

  // GitHub's sub-issues aren't in the issue list; nothing to link.
  children: async () => ({ items: [], next: null }),

  comments: (sctx, cursor) =>
    across<
      {
        id: number;
        body: string;
        created_at: string;
        user: { login: string } | null;
        issue_url: string;
      },
      { id: string; issueId: string; authorId?: string; body: string; createdAt: string }
    >(
      sctx,
      cursor,
      (repo) => `/repos/${repo}/issues/comments?sort=created&direction=asc&per_page=${PER_PAGE}`,
      (repo, c) => {
        const number = /\/issues\/(\d+)$/.exec(c.issue_url)?.[1];
        // Comments on pull requests point at issues the import doesn't have; the engine skips them.
        return number
          ? {
              id: `${repo}#c${c.id}`,
              issueId: `${repo}#${number}`,
              authorId: login(c.user),
              body: c.body,
              createdAt: c.created_at,
            }
          : null;
      },
    ),
};
