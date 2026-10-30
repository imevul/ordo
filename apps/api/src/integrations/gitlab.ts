import { type GitlabConfig, gitlabSettingsSchema, type PullRequestChecks } from '@ordo/shared';
import {
  applyBranch,
  applyCommits,
  applyPullRequest,
  applyPullRequestChecks,
  type ForgePullRequest,
  issueSummaries,
  linkedComment,
  mentionsIssue,
  type PullRequestState,
} from '../services/forge.ts';
import { callApi, safeEqual, withWebhookSecret } from './http.ts';
import {
  configOf,
  type IntegrationContext,
  type IntegrationProvider,
  type IntegrationRow,
} from './types.ts';

/**
 * GitLab (gitlab.com or self-managed) with an access token (`api` scope) and a list of projects.
 * Ordo adds project webhooks, or polls merge requests when GitLab can't reach it.
 */

const cfg = configOf<GitlabConfig>();
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
  last_commit?: { id: string };
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
    head: mr.last_commit?.id,
  };
};

const PIPELINE_CHECKS: Record<string, PullRequestChecks | null> = {
  success: 'passing',
  failed: 'failing',
  canceled: 'failing',
  created: 'pending',
  waiting_for_resource: 'pending',
  preparing: 'pending',
  pending: 'pending',
  running: 'pending',
  scheduled: 'pending',
  manual: 'pending',
  skipped: null,
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

  settings: gitlabSettingsSchema,
  configure: (settings) => withWebhookSecret(settings),

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
      if (c.delivery !== 'webhook') continue;
      const hook = {
        url: `${ictx.app.env.publicUrl}/api/hooks/gitlab/${ictx.integration.inboundToken}`,
        token: ictx.secrets.webhookSecret,
        merge_requests_events: true,
        push_events: true,
        pipeline_events: true,
        enable_ssl_verification: true,
      };
      if (hooks[path]) {
        // Hooks made before Ordo listened for pipelines get them too.
        await api(ictx, `/projects/${project(path)}/hooks/${hooks[path]}`, {
          method: 'PUT',
          body: hook,
        });
        continue;
      }
      const { data } = await api<{ id: number }>(ictx, `/projects/${project(path)}/hooks`, {
        method: 'POST',
        body: hook,
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
      const action = body.object_attributes?.action;
      await handleMergeRequest(ictx, {
        ...pr,
        ...(action === 'approved' && { review: 'approved', reviewed: true }),
        ...(action === 'unapproved' && { review: null }),
      });
    } else if (event === 'Pipeline Hook') {
      const pipeline = body.object_attributes as { sha?: string; status?: string };
      if (!pipeline?.sha || !pipeline.status || !(pipeline.status in PIPELINE_CHECKS)) return;
      const iid = body.merge_request?.iid as number | undefined;
      await applyPullRequestChecks(ictx, {
        sha: pipeline.sha,
        checks: PIPELINE_CHECKS[pipeline.status]!,
        repo,
        numbers: iid ? [iid] : [],
      });
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
