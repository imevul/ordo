import type { CreateApiImportInput, ImportSummary, StateType } from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { ApiCallError, trimUrl } from '../../integrations/http.ts';
import { type ForgeApi, forgeAll, forgeGet, labelKey } from './forge-api.ts';
import { importSecrets } from './secrets.ts';
import {
  ImportAbort,
  type ImportAdapter,
  type Page,
  type SourceComment,
  type SourceContext,
  type SourceIssue,
} from './types.ts';

/**
 * Issues of repositories on GitHub (and GitHub Enterprise Server) or Forgejo/Gitea (Codeberg
 * included), whose APIs are nearly the same. Each repository is a source team; milestones become
 * projects; pull requests are left out. People are logins, matched to usernames members claimed.
 */

interface RepoConfig {
  repos: string[];
  /** The REST API's base URL. */
  apiUrl: string;
  /** Where logins live, as claimed under Connected accounts (github.com, codeberg.org…). */
  webHost?: string;
}

/** What differs between the forges. */
interface Flavor {
  key: 'github' | 'forgejo';
  name: string;
  headers: (token: string) => Record<string, string>;
  /** Page size, as each API spells it. */
  pageSize: string;
  /** Extra query for listing issues: oldest first where the API can, issues only where it can. */
  issueQuery: string;
  /** GitHub refers to milestones by number, Gitea by id. */
  milestoneKey: (m: { number?: number; id?: number }) => number;
  /** The API base and login host for what someone asked to import. */
  endpoint: (input: CreateApiImportInput) => { apiUrl: string; webHost: string };
}

interface RepoIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  /** GitHub only. */
  state_reason?: string | null;
  user: { login: string; email?: string } | null;
  assignee: { login: string } | null;
  labels: ({ name: string } | string)[];
  milestone: { number?: number; id?: number } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  pull_request?: unknown;
}

interface RepoComment {
  id: number;
  body: string;
  created_at: string;
  user: { login: string; email?: string } | null;
  issue_url: string;
}

const STATUSES: Record<string, StateType> = {
  Open: 'unstarted',
  Closed: 'completed',
  'Closed as not planned': 'canceled',
  'Closed as duplicate': 'canceled',
};

function statusOf(i: RepoIssue) {
  if (i.state === 'open') return 'Open';
  if (i.state_reason === 'not_planned') return 'Closed as not planned';
  if (i.state_reason === 'duplicate') return 'Closed as duplicate';
  return 'Closed';
}

const login = (u: { login: string } | null) => u?.login.toLowerCase();
const labelName = (l: { name: string } | string) => (typeof l === 'string' ? l : l.name);
const milestoneId = (repo: string, key: number) => `${repo}#m${key}`;
/** Comments point at their issue by URL; on pull requests that's an issue the import lacks. */
const issueNumber = (url: string) => /\/issues\/(\d+)$/.exec(url)?.[1];
/** Real addresses only: forges hand out no-reply ones too. */
const realEmail = (email: string | undefined) =>
  email && !/noreply|no-reply/i.test(email) ? email : null;

function repoIssuesSource(flavor: Flavor): ImportAdapter {
  const cfg = (sctx: SourceContext) => sctx.row.config as unknown as RepoConfig;
  const apiFor = (app: FastifyInstance, apiUrl: string, token: string): ForgeApi => ({
    app,
    base: apiUrl,
    headers: flavor.headers(token),
    name: flavor.name,
  });
  const api = (sctx: SourceContext) =>
    apiFor(sctx.app, cfg(sctx).apiUrl, importSecrets<{ token: string }>(sctx).token);
  const issuesPath = (repo: string) =>
    `/repos/${repo}/issues?state=all&${flavor.pageSize}${flavor.issueQuery}`;
  const commentsPath = (repo: string) => `/repos/${repo}/issues/comments?${flavor.pageSize}`;

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
    const { data, more } = await forgeGet<T[]>(api(sctx), `${path(repo)}&page=${page}`);
    return {
      items: data.map((item) => map(repo, item)).filter((x): x is R => x !== null),
      next:
        more && data.length
          ? `${repoIndex}:${page! + 1}`
          : repoIndex! + 1 < repos.length
            ? `${repoIndex! + 1}:1`
            : null,
    };
  }

  function toIssue(repo: string, i: RepoIssue): SourceIssue | null {
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
      description: i.body || undefined,
      status,
      assigneeId: login(i.assignee),
      creatorId: login(i.user),
      labelIds: [...new Set(i.labels.map((l) => labelKey(labelName(l))))],
      projectId: i.milestone ? milestoneId(repo, flavor.milestoneKey(i.milestone)) : undefined,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      completedAt: i.state === 'closed' && !canceled ? closed : undefined,
      canceledAt: canceled ? closed : undefined,
      url: i.html_url,
    };
  }

  return {
    key: flavor.key,

    async start(app, input) {
      if (input.source !== flavor.key) throw new Error(`Not a ${flavor.name} import`);
      const token = 'token' in input ? input.token : '';
      const { apiUrl, webHost } = flavor.endpoint(input);
      const repos: string[] = [];
      for (const repo of new Set('repos' in input ? input.repos : [])) {
        try {
          const { data } = await forgeGet<{ full_name: string }>(
            apiFor(app, apiUrl, token),
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
        name: `${flavor.name}: ${repos[0]}${repos.length > 1 ? ` and ${repos.length - 1} more` : ''}`,
        config: { repos, apiUrl, webHost },
        secrets: { token },
      };
    },

    async analyze(sctx) {
      const config = cfg(sctx);
      // Imports started before webHost was kept were all GitHub.
      const host =
        config.webHost ??
        (new URL(config.apiUrl).host === 'api.github.com'
          ? 'github.com'
          : new URL(config.apiUrl).host);
      const users = new Map<string, { email: string | null; count: number }>();
      const labels = new Map<string, { name: string; count: number }>();
      const summary: ImportSummary = {
        teams: [],
        users: [],
        labels: [],
        projects: [],
        counts: { issues: 0, comments: 0 },
        warnings: [],
      };
      const person = (u: { login: string; email?: string } | null) => {
        const id = login(u);
        if (!id) return;
        const entry = users.get(id) ?? { email: null, count: 0 };
        // Assignees come without an email; the first real one seen anywhere counts.
        entry.email ??= realEmail(u!.email);
        entry.count++;
        users.set(id, entry);
      };

      for (const repo of config.repos) {
        for (const l of await forgeAll<{ name: string }>(
          api(sctx),
          `/repos/${repo}/labels?${flavor.pageSize}`,
        )) {
          const id = labelKey(l.name);
          if (!labels.has(id)) labels.set(id, { name: l.name, count: 0 });
        }
        const milestones = await forgeAll<{
          number?: number;
          id?: number;
          title: string;
          description: string | null;
          state: 'open' | 'closed';
          due_on: string | null;
        }>(api(sctx), `/repos/${repo}/milestones?state=all&${flavor.pageSize}`);
        const perMilestone = new Map<number, number>();
        const statuses = new Map<string, number>([
          ['Open', 0],
          ['Closed', 0],
        ]);
        let issueCount = 0;
        const numbers = new Set<number>();
        for (const i of await forgeAll<RepoIssue>(api(sctx), issuesPath(repo))) {
          if (i.pull_request) continue;
          issueCount++;
          numbers.add(i.number);
          summary.counts.comments += i.comments;
          const status = statusOf(i);
          statuses.set(status, (statuses.get(status) ?? 0) + 1);
          person(i.assignee);
          person(i.user);
          for (const l of i.labels) {
            const label = labels.get(labelKey(labelName(l)));
            if (label) label.count++;
          }
          if (i.milestone) {
            const key = flavor.milestoneKey(i.milestone);
            perMilestone.set(key, (perMilestone.get(key) ?? 0) + 1);
          }
        }
        // Commenters can be people who never opened or took an issue; they need mapping too.
        for (const c of await forgeAll<RepoComment>(api(sctx), commentsPath(repo))) {
          if (numbers.has(Number(issueNumber(c.issue_url)))) person(c.user);
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
          const key = flavor.milestoneKey(m);
          summary.projects.push({
            id: milestoneId(repo, key),
            name: m.title,
            count: perMilestone.get(key) ?? 0,
            teamIds: [repo],
            description: m.description,
            status: m.state === 'open' ? 'planned' : 'completed',
            targetDate: m.due_on?.slice(0, 10) ?? null,
          });
        }
      }

      summary.users = [...users].map(([id, u]) => ({
        id,
        name: id,
        email: u.email,
        count: u.count,
        account: { provider: flavor.key, host, login: id },
      }));
      summary.labels = [...labels].map(([id, l]) => ({ id, ...l }));
      return { summary };
    },

    issues: (sctx, cursor) => across<RepoIssue, SourceIssue>(sctx, cursor, issuesPath, toIssue),

    // Sub-issues aren't in the issue lists; nothing to link.
    children: async () => ({ items: [], next: null }),

    comments: (sctx, cursor) =>
      across<RepoComment, SourceComment>(sctx, cursor, commentsPath, (repo, c) => {
        const number = issueNumber(c.issue_url);
        return number
          ? {
              id: `${repo}#c${c.id}`,
              issueId: `${repo}#${number}`,
              authorId: login(c.user),
              body: c.body,
              createdAt: c.created_at,
            }
          : null;
      }),
  };
}

export const githubSource = repoIssuesSource({
  key: 'github',
  name: 'GitHub',
  headers: (token) => ({
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }),
  pageSize: 'per_page=100',
  issueQuery: '&sort=created&direction=asc',
  milestoneKey: (m) => m.number!,
  endpoint: (input) => {
    const apiUrl = trimUrl(('apiUrl' in input && input.apiUrl) || 'https://api.github.com');
    const host = new URL(apiUrl).host;
    return { apiUrl, webHost: host === 'api.github.com' ? 'github.com' : host };
  },
});

export const forgejoSource = repoIssuesSource({
  key: 'forgejo',
  name: 'Forgejo',
  headers: (token) => ({ authorization: `token ${token}` }),
  // Gitea caps pages at 50 by default.
  pageSize: 'limit=50',
  issueQuery: '&type=issues',
  milestoneKey: (m) => m.id!,
  endpoint: (input) => {
    const baseUrl = trimUrl('baseUrl' in input ? input.baseUrl : '');
    return { apiUrl: `${baseUrl}/api/v1`, webHost: new URL(baseUrl).host };
  },
});
