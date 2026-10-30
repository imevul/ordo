import { createPrivateKey, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { integrationApps, integrations } from '../db/schema.ts';
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
import { readAppSecrets } from '../services/integrations.ts';
import { callApi, hmacHex, repoList, safeEqual, trimUrl } from './http.ts';
import type {
  InboundRequest,
  IntegrationContext,
  IntegrationProvider,
  IntegrationRow,
} from './types.ts';

/**
 * GitHub (and GitHub Enterprise Server via `apiUrl`/`webUrl`).
 *
 * - App mode: an instance-wide GitHub App (created in one click from its manifest), installed per
 *   workspace. One webhook URL for the app: /api/hooks/github/app-<appId>.
 * - Token mode: a personal access token and a list of repositories, receiving webhooks Ordo
 *   creates on each repository, or polling when GitHub can't reach this instance.
 */

interface GithubConfig {
  mode: 'app' | 'token';
  apiUrl: string;
  webUrl: string;
  repos: string[];
  delivery: 'webhook' | 'poll';
  commentOnPullRequests: boolean;
}

const DEFAULT_API = 'https://api.github.com';
const DEFAULT_WEB = 'https://github.com';

const cfg = (row: IntegrationRow) => row.config as unknown as GithubConfig;
export const githubHost = (row: IntegrationRow) => new URL(cfg(row).webUrl || DEFAULT_WEB).host;

// Installation tokens live an hour; reuse them until five minutes before that.
const installationTokens = new Map<string, { token: string; expires: number }>();

export async function appJwt(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .setIssuer(appId)
    .sign(createPrivateKey(privateKey));
}

async function appRow(app: FastifyInstance, id: string) {
  const [row] = await app.db.select().from(integrationApps).where(eq(integrationApps.id, id));
  if (!row) throw new Error('The GitHub App behind this integration was deleted');
  return row;
}

async function token(ictx: IntegrationContext): Promise<string> {
  const row = ictx.integration;
  if (cfg(row).mode !== 'app') return ictx.secrets.token!;
  const cached = installationTokens.get(row.id);
  if (cached && cached.expires > Date.now() + 300_000) return cached.token;
  const appInfo = await appRow(ictx.app, row.appId!);
  const appConfig = appInfo.config as { appId: string; apiUrl?: string };
  const jwt = await appJwt(String(appConfig.appId), readAppSecrets(ictx.app, appInfo).privateKey!);
  const { data } = await callApi<{ token: string; expires_at: string }>(
    ictx.app,
    `${appConfig.apiUrl ?? DEFAULT_API}/app/installations/${row.externalId}/access_tokens`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json' },
    },
  );
  installationTokens.set(row.id, {
    token: data.token,
    expires: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

async function gh<T>(
  ictx: IntegrationContext,
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return callApi<T>(ictx.app, `${cfg(ictx.integration).apiUrl || DEFAULT_API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${await token(ictx)}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...opts.headers,
    },
  });
}

// ─── payload mapping ────────────────────────────────────────────────────

interface GhPull {
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
  requested_reviewers?: unknown[];
  requested_teams?: unknown[];
}

export function pullState(pr: GhPull, action?: string): PullRequestState {
  if (pr.merged || pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  if (action === 'review_requested' || pr.requested_reviewers?.length || pr.requested_teams?.length)
    return 'review';
  return 'open';
}

const toPull = (pr: GhPull, repo: string, state: PullRequestState): ForgePullRequest => ({
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
  const linked = await applyPullRequest(ictx, githubHost(ictx.integration), pr);
  const fresh = linked.filter((l) => l.created).map((l) => l.issueId);
  if (fresh.length && cfg(ictx.integration).commentOnPullRequests) {
    await gh(ictx, `/repos/${pr.repo}/issues/${pr.number}/comments`, {
      method: 'POST',
      body: { body: linkedComment(await issueSummaries(ictx, fresh)) },
    });
  }
}

interface GhPush {
  ref: string;
  created?: boolean;
  deleted?: boolean;
  repository: { full_name: string; html_url: string; default_branch: string };
  commits?: {
    id: string;
    message: string;
    url: string;
    author?: { name?: string; username?: string };
  }[];
}

async function handlePush(ictx: IntegrationContext, push: GhPush) {
  if (push.deleted || !push.ref.startsWith('refs/heads/')) return;
  const branch = push.ref.slice('refs/heads/'.length);
  const repo = push.repository.full_name;
  if (push.created && mentionsIssue(branch)) {
    await applyBranch(ictx, {
      repo,
      name: branch,
      url: `${push.repository.html_url}/tree/${encodeURIComponent(branch)}`,
    });
  }
  const commits = (push.commits ?? []).filter((c) => mentionsIssue(c.message));
  if (commits.length) {
    await applyCommits(
      ictx,
      repo,
      commits.map((c) => ({
        sha: c.id,
        message: c.message,
        url: c.url,
        author: c.author?.username ?? c.author?.name ?? null,
      })),
      branch === push.repository.default_branch,
    );
  }
}

// ─── the provider ───────────────────────────────────────────────────────

export const github: IntegrationProvider = {
  key: 'github',
  name: 'GitHub',
  description:
    'Link pull requests, branches and commits to issues and move issues as PRs progress.',
  category: 'forge',

  accountHost: githubHost,

  /** Everything the token or installation can see, not only the repositories it's hooked to. */
  listRepositories(ictx, query) {
    const app = cfg(ictx.integration).mode === 'app';
    return collectRepositories(
      100,
      async (page) => {
        if (app) {
          const { data } = await gh<{ repositories: ForgeRepoPayload[] }>(
            ictx,
            `/installation/repositories?per_page=100&page=${page}`,
          );
          return data.repositories ?? [];
        }
        const { data } = await gh<ForgeRepoPayload[]>(
          ictx,
          `/user/repos?per_page=100&page=${page}&sort=full_name`,
        );
        return data ?? [];
      },
      query,
    );
  },

  configure({ config, secrets }) {
    if (config.mode === 'app') {
      // Installed through the GitHub App: only the preferences are editable.
      return {
        config: { ...config, commentOnPullRequests: config.commentOnPullRequests === true },
        secrets: secrets as Record<string, string>,
      };
    }
    const repos = repoList(config.repos);
    if (!secrets.token) throw new Error('A personal access token is required');
    if (!repos.length) throw new Error('List at least one repository (owner/name)');
    const bad = repos.find((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
    if (bad) throw new Error(`"${bad}" isn't a repository name (owner/name)`);
    return {
      config: {
        mode: 'token',
        apiUrl: trimUrl(String(config.apiUrl || DEFAULT_API)),
        webUrl: trimUrl(String(config.webUrl || DEFAULT_WEB)),
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

  /** Also called after settings change: creates missing repository hooks, removes stale ones. */
  async install(ictx) {
    const c = cfg(ictx.integration);
    if (c.mode !== 'token') return;
    const previous = (ictx.integration.state.hooks ?? {}) as Record<string, number>;
    const hooks: Record<string, number> = {};
    for (const [repo, id] of Object.entries(previous)) {
      if (c.delivery === 'webhook' && c.repos.includes(repo)) hooks[repo] = id;
      else await gh(ictx, `/repos/${repo}/hooks/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const repo of c.repos) {
      await gh(ictx, `/repos/${repo}`); // fails early with a clear message if the token can't see it
      if (c.delivery !== 'webhook' || hooks[repo]) continue;
      const { data } = await gh<{ id: number }>(ictx, `/repos/${repo}/hooks`, {
        method: 'POST',
        body: {
          name: 'web',
          active: true,
          events: ['pull_request', 'pull_request_review', 'push'],
          config: {
            url: `${ictx.app.env.publicUrl}/api/hooks/github/${ictx.integration.inboundToken}`,
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
      await gh(ictx, `/repos/${repo}/hooks/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  },

  async resolveInbound(app, key, req) {
    if (!key.startsWith('app-')) {
      return app.db
        .select()
        .from(integrations)
        .where(and(eq(integrations.provider, 'github'), eq(integrations.inboundToken, key)));
    }
    let installation: string | undefined;
    try {
      installation = String(
        (JSON.parse(req.body) as { installation?: { id: number } }).installation?.id ?? '',
      );
    } catch {
      return [];
    }
    if (!installation) return [];
    return app.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.provider, 'github'),
          eq(integrations.appId, key.slice('app-'.length)),
          eq(integrations.externalId, installation),
        ),
      );
  },

  verify(req, _row, secrets) {
    const sig = req.headers['x-hub-signature-256'];
    return (
      !!secrets.webhookSecret &&
      safeEqual(sig, `sha256=${hmacHex(secrets.webhookSecret, req.body)}`)
    );
  },

  deliveryId: (req) => req.headers['x-github-delivery'] ?? null,

  async handleInbound(ictx, req: InboundRequest) {
    const event = req.headers['x-github-event'];
    const body = JSON.parse(req.body);
    if (event === 'pull_request' || event === 'pull_request_review') {
      const pr = body.pull_request as GhPull;
      let state = pullState(pr, body.action);
      // Someone reviewing an open PR means it's in review.
      if (event === 'pull_request_review' && state === 'open') state = 'review';
      await handlePull(ictx, toPull(pr, body.repository.full_name, state));
    } else if (event === 'push') {
      await handlePush(ictx, body as GhPush);
    } else if (event === 'installation') {
      const off = body.action === 'deleted' || body.action === 'suspend';
      if (off || body.action === 'unsuspend') {
        await ictx.app.db
          .update(integrations)
          .set(
            off
              ? {
                  status: 'disabled',
                  lastError: `The GitHub App was ${body.action === 'deleted' ? 'uninstalled' : 'suspended'} on GitHub`,
                }
              : { status: 'active', lastError: null },
          )
          .where(eq(integrations.id, ictx.integration.id));
      }
    }
  },

  pollIntervalSeconds: 120,

  async poll(ictx) {
    const c = cfg(ictx.integration);
    if (c.mode !== 'token' || c.delivery !== 'poll') return;
    const cursors = (ictx.integration.state.cursors ?? {}) as Record<string, string>;
    const commitCursors = (ictx.integration.state.commitCursors ?? {}) as Record<string, string>;
    const lookBack = new Date(Date.now() - 7 * 86_400_000).toISOString();
    for (const repo of c.repos) {
      const since = cursors[repo] ?? lookBack;
      const { data: pulls } = await gh<GhPull[]>(
        ictx,
        `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
      );
      // Forges format timestamps differently (with or without milliseconds): compare times, not strings.
      const changed = pulls.filter((p) => Date.parse(p.updated_at) > Date.parse(since)).reverse();
      for (const pr of changed) await handlePull(ictx, toPull(pr, repo, pullState(pr)));
      if (changed.length) cursors[repo] = changed.at(-1)!.updated_at;

      const commitSince = commitCursors[repo] ?? lookBack;
      const { data: commits } = await gh<
        {
          sha: string;
          html_url: string;
          commit: { message: string; committer: { date: string } };
          author: { login: string } | null;
        }[]
      >(ictx, `/repos/${repo}/commits?since=${encodeURIComponent(commitSince)}&per_page=100`);
      const mentioned = commits.filter((cm) => mentionsIssue(cm.commit.message));
      if (mentioned.length) {
        await applyCommits(
          ictx,
          repo,
          mentioned.map((cm) => ({
            sha: cm.sha,
            message: cm.commit.message,
            url: cm.html_url,
            author: cm.author?.login ?? null,
          })),
          true, // the commits endpoint lists the default branch
        );
      }
      if (commits.length) {
        // "since" is inclusive; step past the newest commit we've seen.
        const newest = commits
          .map((cm) => cm.commit.committer.date)
          .sort()
          .at(-1)!;
        commitCursors[repo] = new Date(new Date(newest).getTime() + 1000).toISOString();
      }
    }
    await ictx.saveState({ cursors, commitCursors });
  },
};
