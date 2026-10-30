import { randomBytes } from 'node:crypto';
import {
  applyBranch,
  applyCommits,
  applyPullRequest,
  collectRepositories,
  type ForgePullRequest,
  type ForgeRepoPayload,
  issueSummaries,
  linkedComment,
  mentionsIssue,
  type PullRequestState,
} from '../services/forge.ts';
import { callApi, hmacHex, repoList, safeEqual, trimUrl } from './http.ts';
import type { IntegrationContext, IntegrationProvider, IntegrationRow } from './types.ts';

/**
 * Forgejo and Gitea (Codeberg included): an access token and a list of repositories. Ordo adds
 * repository webhooks, or polls pull requests when the forge can't reach it.
 */

interface ForgejoConfig {
  baseUrl: string;
  repos: string[];
  delivery: 'webhook' | 'poll';
  commentOnPullRequests: boolean;
}

const cfg = (row: IntegrationRow) => row.config as unknown as ForgejoConfig;
const host = (row: IntegrationRow) => new URL(cfg(row).baseUrl).host;

const api = <T>(
  ictx: IntegrationContext,
  path: string,
  opts: { method?: string; body?: unknown } = {},
) =>
  callApi<T>(ictx.app, `${cfg(ictx.integration).baseUrl}/api/v1${path}`, {
    ...opts,
    headers: { authorization: `token ${ictx.secrets.token}` },
  });

interface FjPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  updated_at: string;
  head: { ref: string };
  user: { id: number; login: string } | null;
  requested_reviewers?: unknown[] | null;
}

export function forgejoPullState(pr: FjPull, action?: string): PullRequestState {
  if (pr.merged || pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  // Older Gitea marks drafts only by a "WIP:" title prefix.
  if (pr.draft || /^\s*(\[?wip\]?:?|draft:)\s/i.test(pr.title)) return 'draft';
  if (action === 'review_requested' || pr.requested_reviewers?.length) return 'review';
  return 'open';
}

const toPull = (pr: FjPull, repo: string, state: PullRequestState): ForgePullRequest => ({
  repo,
  number: pr.number,
  url: pr.html_url,
  title: pr.title,
  body: pr.body ?? '',
  branch: pr.head.ref,
  state,
  author: pr.user ? { id: String(pr.user.id), login: pr.user.login } : null,
});

async function handlePull(ictx: IntegrationContext, pr: ForgePullRequest) {
  const linked = await applyPullRequest(ictx, host(ictx.integration), pr);
  const fresh = linked.filter((l) => l.created).map((l) => l.issueId);
  if (fresh.length && cfg(ictx.integration).commentOnPullRequests) {
    await api(ictx, `/repos/${pr.repo}/issues/${pr.number}/comments`, {
      method: 'POST',
      body: { body: linkedComment(await issueSummaries(ictx, fresh)) },
    });
  }
}

/** Forgejo sends X-Forgejo-*, Gitea X-Gitea-*; Forgejo sends both. */
const header = (h: Record<string, string>, name: string) =>
  h[`x-forgejo-${name}`] ?? h[`x-gitea-${name}`];

export const forgejo: IntegrationProvider = {
  key: 'forgejo',
  name: 'Forgejo / Gitea',
  description: 'Link pull requests, branches and commits from Forgejo, Gitea or Codeberg.',
  category: 'forge',

  accountHost: host,

  listRepositories: (ictx, query) =>
    // Forgejo caps pages at 50 by default.
    collectRepositories(
      50,
      async (page) =>
        (await api<ForgeRepoPayload[]>(ictx, `/user/repos?limit=50&page=${page}`)).data ?? [],
      query,
    ),

  configure({ config, secrets }) {
    const repos = repoList(config.repos);
    if (!secrets.token) throw new Error('An access token is required');
    if (!config.baseUrl) throw new Error('The server URL is required, e.g. https://codeberg.org');
    if (!repos.length) throw new Error('List at least one repository (owner/name)');
    let baseUrl: string;
    try {
      baseUrl = trimUrl(new URL(String(config.baseUrl)).toString());
    } catch {
      throw new Error('The server URL is not valid');
    }
    return {
      config: {
        baseUrl,
        repos,
        delivery: config.delivery === 'poll' ? 'poll' : 'webhook',
        commentOnPullRequests: config.commentOnPullRequests === true,
      },
      secrets: {
        token: String(secrets.token),
        webhookSecret: String(secrets.webhookSecret || randomBytes(24).toString('base64url')),
      },
    };
  },

  async install(ictx) {
    const c = cfg(ictx.integration);
    const previous = (ictx.integration.state.hooks ?? {}) as Record<string, number>;
    const hooks: Record<string, number> = {};
    for (const [repo, id] of Object.entries(previous)) {
      if (c.delivery === 'webhook' && c.repos.includes(repo)) hooks[repo] = id;
      else await api(ictx, `/repos/${repo}/hooks/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const repo of c.repos) {
      await api(ictx, `/repos/${repo}`);
      if (c.delivery !== 'webhook' || hooks[repo]) continue;
      const { data } = await api<{ id: number }>(ictx, `/repos/${repo}/hooks`, {
        method: 'POST',
        body: {
          type: 'gitea',
          active: true,
          events: ['push', 'pull_request', 'pull_request_sync', 'pull_request_review_request'],
          config: {
            url: `${ictx.app.env.publicUrl}/api/hooks/forgejo/${ictx.integration.inboundToken}`,
            content_type: 'json',
            secret: ictx.secrets.webhookSecret,
          },
        },
      });
      hooks[repo] = data.id;
    }
    await ictx.saveState({ hooks });
  },

  async uninstall(ictx) {
    const hooks = (ictx.integration.state.hooks ?? {}) as Record<string, number>;
    for (const [repo, id] of Object.entries(hooks)) {
      await api(ictx, `/repos/${repo}/hooks/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  },

  verify: (req, _row, secrets) =>
    !!secrets.webhookSecret &&
    safeEqual(header(req.headers, 'signature'), hmacHex(secrets.webhookSecret, req.body)),

  deliveryId: (req) => header(req.headers, 'delivery') ?? null,

  async handleInbound(ictx, req) {
    const event = header(req.headers, 'event');
    const body = JSON.parse(req.body);
    const repo = body.repository?.full_name as string;
    if (event?.startsWith('pull_request')) {
      const pr = body.pull_request as FjPull;
      await handlePull(ictx, toPull(pr, repo, forgejoPullState(pr, body.action)));
    } else if (event === 'push') {
      if (!String(body.ref).startsWith('refs/heads/') || /^0+$/.test(body.after ?? '')) return;
      const branch = String(body.ref).slice('refs/heads/'.length);
      if (/^0+$/.test(body.before ?? '') && mentionsIssue(branch)) {
        await applyBranch(ictx, {
          repo,
          name: branch,
          url: `${body.repository.html_url}/src/branch/${encodeURIComponent(branch)}`,
        });
      }
      const commits = (
        (body.commits ?? []) as {
          id: string;
          message: string;
          url: string;
          author?: { name?: string; username?: string };
        }[]
      ).filter((cm) => mentionsIssue(cm.message));
      if (commits.length) {
        await applyCommits(
          ictx,
          repo,
          commits.map((cm) => ({
            sha: cm.id,
            message: cm.message,
            url: cm.url,
            author: cm.author?.username || cm.author?.name || null,
          })),
          branch === body.repository?.default_branch,
        );
      }
    }
  },

  pollIntervalSeconds: 120,

  async poll(ictx) {
    const c = cfg(ictx.integration);
    if (c.delivery !== 'poll') return;
    const cursors = (ictx.integration.state.cursors ?? {}) as Record<string, string>;
    const lookBack = new Date(Date.now() - 7 * 86_400_000).toISOString();
    for (const repo of c.repos) {
      const since = cursors[repo] ?? lookBack;
      const { data: pulls } = await api<FjPull[]>(
        ictx,
        `/repos/${repo}/pulls?state=all&sort=recentupdate&limit=50`,
      );
      const changed = pulls
        .filter((p) => Date.parse(p.updated_at) > Date.parse(since))
        .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
      for (const pr of changed) await handlePull(ictx, toPull(pr, repo, forgejoPullState(pr)));
      if (changed.length) cursors[repo] = changed.at(-1)!.updated_at;
    }
    await ictx.saveState({ cursors });
  },
};
