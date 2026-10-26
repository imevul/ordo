import { randomBytes } from 'node:crypto';
import {
  applyBranch,
  applyCommits,
  applyPullRequest,
  type ForgePullRequest,
  issueSummaries,
  linkedComment,
  mentionsIssue,
  type PullRequestState,
} from '../services/forge.ts';
import { callApi, repoList, safeEqual, trimUrl } from './http.ts';
import type { IntegrationContext, IntegrationProvider, IntegrationRow } from './types.ts';

/**
 * GitLab (gitlab.com or self-managed) with an access token (`api` scope) and a list of projects.
 * Ordo adds project webhooks, or polls merge requests when GitLab can't reach it.
 */

interface GitlabConfig {
  baseUrl: string;
  projects: string[];
  delivery: 'webhook' | 'poll';
  commentOnPullRequests: boolean;
}

const cfg = (row: IntegrationRow) => row.config as unknown as GitlabConfig;
const host = (row: IntegrationRow) => new URL(cfg(row).baseUrl).host;
const project = (path: string) => encodeURIComponent(path);

const api = <T>(
  ictx: IntegrationContext,
  path: string,
  opts: { method?: string; body?: unknown } = {},
) =>
  callApi<T>(ictx.app, `${cfg(ictx.integration).baseUrl}/api/v4${path}`, {
    ...opts,
    headers: { 'private-token': ictx.secrets.token! },
  });

interface GlMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  source_branch: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  draft?: boolean;
  work_in_progress?: boolean;
  web_url?: string;
  url?: string;
  updated_at: string;
  reviewers?: unknown[];
  author?: { id: number; username: string };
}

export function mergeRequestState(mr: GlMergeRequest, reviewers?: unknown[]): PullRequestState {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed' || mr.state === 'locked') return 'closed';
  if (mr.draft || mr.work_in_progress) return 'draft';
  if ((reviewers ?? mr.reviewers)?.length) return 'review';
  return 'open';
}

const toPull = (
  mr: GlMergeRequest,
  repo: string,
  state: PullRequestState,
  author?: { id: number; username: string } | null,
): ForgePullRequest => {
  const who = author ?? mr.author ?? null;
  return {
    repo,
    number: mr.iid,
    url: mr.web_url ?? mr.url ?? '',
    title: mr.title,
    body: mr.description ?? '',
    branch: mr.source_branch,
    state,
    author: who ? { id: String(who.id), login: who.username } : null,
  };
};

async function handleMergeRequest(ictx: IntegrationContext, pr: ForgePullRequest) {
  const linked = await applyPullRequest(ictx, host(ictx.integration), pr);
  const fresh = linked.filter((l) => l.created).map((l) => l.issueId);
  if (fresh.length && cfg(ictx.integration).commentOnPullRequests) {
    await api(ictx, `/projects/${project(pr.repo)}/merge_requests/${pr.number}/notes`, {
      method: 'POST',
      body: { body: linkedComment(await issueSummaries(ictx, fresh)) },
    });
  }
}

export const gitlab: IntegrationProvider = {
  key: 'gitlab',
  name: 'GitLab',
  description: 'Link merge requests, branches and commits from GitLab.com or your own GitLab.',
  category: 'forge',

  accountHost: host,

  configure({ config, secrets }) {
    const projects = repoList(config.projects);
    if (!secrets.token) throw new Error('An access token with the "api" scope is required');
    if (!projects.length) throw new Error('List at least one project (group/project)');
    let baseUrl: string;
    try {
      baseUrl = trimUrl(new URL(String(config.baseUrl || 'https://gitlab.com')).toString());
    } catch {
      throw new Error('The GitLab URL is not valid');
    }
    return {
      config: {
        baseUrl,
        projects,
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
    for (const [path, id] of Object.entries(previous)) {
      if (c.delivery === 'webhook' && c.projects.includes(path)) hooks[path] = id;
      else
        await api(ictx, `/projects/${project(path)}/hooks/${id}`, { method: 'DELETE' }).catch(
          () => {},
        );
    }
    for (const path of c.projects) {
      await api(ictx, `/projects/${project(path)}`);
      if (c.delivery !== 'webhook' || hooks[path]) continue;
      const { data } = await api<{ id: number }>(ictx, `/projects/${project(path)}/hooks`, {
        method: 'POST',
        body: {
          url: `${ictx.app.env.publicUrl}/api/hooks/gitlab/${ictx.integration.inboundToken}`,
          token: ictx.secrets.webhookSecret,
          merge_requests_events: true,
          push_events: true,
          enable_ssl_verification: true,
        },
      });
      hooks[path] = data.id;
    }
    await ictx.saveState({ hooks });
  },

  async uninstall(ictx) {
    const hooks = (ictx.integration.state.hooks ?? {}) as Record<string, number>;
    for (const [path, id] of Object.entries(hooks)) {
      await api(ictx, `/projects/${project(path)}/hooks/${id}`, { method: 'DELETE' }).catch(
        () => {},
      );
    }
  },

  verify: (req, _row, secrets) => safeEqual(req.headers['x-gitlab-token'], secrets.webhookSecret),

  deliveryId: (req) => req.headers['x-gitlab-event-uuid'] ?? req.headers['idempotency-key'] ?? null,

  async handleInbound(ictx, req) {
    const event = req.headers['x-gitlab-event'];
    const body = JSON.parse(req.body);
    const repo = body.project?.path_with_namespace as string;
    if (event === 'Merge Request Hook') {
      const mr = body.object_attributes as GlMergeRequest;
      const author = body.user ? { id: body.user.id, username: body.user.username } : null;
      // The MR author isn't in the payload; the user is whoever triggered the event.
      const pr = toPull(
        mr,
        repo,
        mergeRequestState(mr, body.reviewers),
        mr.author ?? (body.object_attributes?.action === 'open' ? author : null),
      );
      await handleMergeRequest(ictx, pr);
    } else if (event === 'Push Hook') {
      if (!String(body.ref).startsWith('refs/heads/') || /^0+$/.test(body.after)) return;
      const branch = String(body.ref).slice('refs/heads/'.length);
      const webUrl = body.project?.web_url as string;
      if (/^0+$/.test(body.before) && mentionsIssue(branch)) {
        await applyBranch(ictx, {
          repo,
          name: branch,
          url: `${webUrl}/-/tree/${encodeURIComponent(branch)}`,
        });
      }
      const commits = (
        (body.commits ?? []) as {
          id: string;
          message: string;
          url: string;
          author?: { name?: string };
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
            author: cm.author?.name ?? null,
          })),
          branch === body.project?.default_branch,
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
    for (const path of c.projects) {
      const since = cursors[path] ?? lookBack;
      const { data: mrs } = await api<GlMergeRequest[]>(
        ictx,
        `/projects/${project(path)}/merge_requests?updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc&per_page=100&scope=all`,
      );
      const changed = mrs.filter((m) => Date.parse(m.updated_at) > Date.parse(since));
      for (const mr of changed)
        await handleMergeRequest(ictx, toPull(mr, path, mergeRequestState(mr)));
      if (changed.length) cursors[path] = changed.at(-1)!.updated_at;
    }
    await ictx.saveState({ cursors });
  },
};
