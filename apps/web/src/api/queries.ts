import type {
  Account,
  ApiKey,
  Attachment,
  Bootstrap,
  Comment,
  CommentReaction,
  CreateIssueInput,
  HistoryEntry,
  InstanceConfig,
  Invite,
  Issue,
  IssueDetail,
  IssueFilter,
  Me,
  Notification,
  OAuthGrant,
  ProjectUpdate,
  SearchResults,
  SessionInfo,
  UpdateIssueInput,
} from '@ordo/shared';
import type { Engine } from '@ordo/sync';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { t } from '../i18n/index.ts';
import { useLocalIssues, useSync, useSyncEngine, useSyncState } from '../sync/context.tsx';
import { keepsCopy } from '../sync/device.ts';
import { ApiError, api, upload, wsPath } from './client.ts';

export const keys = {
  config: ['config'] as const,
  me: ['me'] as const,
  account: ['account'] as const,
  sessions: ['sessions'] as const,
  apiKeys: ['apiKeys'] as const,
  oauthGrants: ['oauthGrants'] as const,
  ws: (slug: string) => ['ws', slug] as const,
  bootstrap: (slug: string) => ['ws', slug, 'bootstrap'] as const,
  issues: (slug: string, filter?: IssueFilter) => ['ws', slug, 'issues', filter ?? {}] as const,
  issue: (slug: string, id?: string) =>
    id ? (['ws', slug, 'issue', id] as const) : (['ws', slug, 'issue'] as const),
  comments: (slug: string, issueId: string) => ['ws', slug, 'comments', issueId] as const,
  history: (slug: string, issueId: string) => ['ws', slug, 'history', issueId] as const,
  notifications: (slug: string) => ['ws', slug, 'notifications'] as const,
  projectUpdates: (slug: string, projectId: string) =>
    ['ws', slug, 'projectUpdates', projectId] as const,
  invites: (slug: string) => ['ws', slug, 'invites'] as const,
  search: (slug: string, q: string) => ['ws', slug, 'search', q] as const,
};

/** The server can't be reached (a proxy answering for a stopped API counts). */
export const unreachable = (err: unknown) =>
  err instanceof ApiError && (err.status === 0 || err.status >= 502);

const remembered = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const remember = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

export const ME_KEY = 'ordo:me';
const CONFIG_KEY = 'ordo:config';

/** The instance's config; offline, the last one seen, so the app can start without a server. */
export const useConfig = () =>
  useQuery({
    queryKey: keys.config,
    queryFn: async () => {
      try {
        const config = await api.get<InstanceConfig>('/config');
        remember(CONFIG_KEY, config);
        return config;
      } catch (err) {
        const saved = unreachable(err) ? remembered<InstanceConfig>(CONFIG_KEY) : null;
        if (saved) return saved;
        throw err;
      }
    },
  });

/**
 * Who's signed in (null: nobody). Devices that keep an offline copy remember it, so the app
 * starts offline too; signing out forgets it.
 */
export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        const me = await api.get<Me>('/auth/me');
        remember(
          ME_KEY,
          keepsCopy(remembered<InstanceConfig>(CONFIG_KEY)?.offlineSync) ? me : null,
        );
        return me;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          remember(ME_KEY, null);
          return null;
        }
        const saved = unreachable(err) ? remembered<Me>(ME_KEY) : null;
        if (saved) return saved;
        throw err;
      }
    },
    staleTime: 60_000,
  });

export const useBootstrap = (slug: string) =>
  useQuery({
    queryKey: keys.bootstrap(slug),
    queryFn: () => api.get<Bootstrap>(wsPath(slug, '/bootstrap')),
    staleTime: 30_000,
  });

const ISSUE_PAGE = 1000;

/**
 * Every issue matching `filter`. With a local copy (sync), straight from it; otherwise loaded a
 * page at a time, what's loaded showing while the rest arrives. Screens sort and group on their
 * side.
 */
export function useIssues(slug: string, filter: IssueFilter, enabled = true) {
  const qc = useQueryClient();
  const me = useMe().data;
  const local = useLocalIssues(filter, me?.id ?? '');
  const fromCopy = !!local.issues || local.waiting;
  const queryKey = keys.issues(slug, filter);
  const remote = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const all: Issue[] = [];
      let after: string | null = null;
      for (;;) {
        const page: Issue[] = await api.post<Issue[]>(wsPath(slug, '/issues/query'), {
          filter,
          after,
          limit: ISSUE_PAGE,
        });
        all.push(...page);
        if (page.length < ISSUE_PAGE) return all;
        // A newer fetch (after a realtime change) took over; don't show this one's partial list.
        if (signal.aborted) throw signal.reason;
        qc.setQueryData(queryKey, [...all]);
        after = page.at(-1)!.id;
      }
    },
    enabled: enabled && !fromCopy,
    placeholderData: (prev) => prev,
  });
  if (fromCopy) return { data: local.issues, isLoading: !local.issues, error: null };
  return { data: remote.data, isLoading: remote.isLoading, error: remote.error };
}

/** An issue's page from the local copy, while the server's is on its way (or offline). */
function detailFromCopy(engine: Engine, idOrIdentifier: string): IssueDetail | undefined {
  const issue = engine.issue(idOrIdentifier);
  if (!issue) return undefined;
  const all = engine.getState().issues;
  const parent = issue.parentId ? all.get(issue.parentId) : undefined;
  return {
    ...issue,
    parent: parent
      ? {
          id: parent.id,
          identifier: parent.identifier,
          title: parent.title,
          stateId: parent.stateId,
          teamId: parent.teamId,
        }
      : null,
    subIssues: [...all.values()].filter((i) => i.parentId === issue.id),
    // Not in the copy: these show once the server answers.
    relations: [],
    subscriberIds: [],
    links: [],
    attachments: [],
    customerRequests: [],
  };
}

export function useIssue(slug: string, id: string | undefined) {
  const sync = useSync();
  const state = useSyncState();
  const remote = useQuery({
    queryKey: keys.issue(slug, id ?? ''),
    queryFn: () => api.get<IssueDetail>(wsPath(slug, `/issues/${id}`)),
    enabled: !!id,
  });
  const copy = useMemo(
    () =>
      !remote.data && id && sync.status === 'on' && state?.ready
        ? detailFromCopy(sync.engine, id)
        : undefined,
    [remote.data, id, sync, state],
  );
  const data = remote.data ?? copy;
  return { data, isLoading: remote.isLoading && !data, error: data ? null : remote.error };
}

/** An issue's comments; kept in the local copy (when there is one) for reading offline. */
export function useComments(slug: string, issueId: string | undefined) {
  const sync = useSync();
  const engine = sync.status === 'on' ? sync.engine : null;
  const remote = useQuery({
    queryKey: keys.comments(slug, issueId ?? ''),
    queryFn: async () => {
      const list = await api.get<Comment[]>(wsPath(slug, `/issues/${issueId}/comments`));
      if (engine && issueId) void engine.saveComments(issueId, list);
      return list;
    },
    enabled: !!issueId,
  });
  const [saved, setSaved] = useState<Comment[] | undefined>();
  // Re-reads when the outbox changes, so queued comments show.
  const version = useSyncState()?.version;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` marks a changed outbox
  useEffect(() => {
    setSaved(undefined);
    if (engine && issueId && !remote.data) void engine.commentsFor(issueId).then(setSaved);
  }, [engine, issueId, remote.data, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` marks a changed outbox
  const data = useMemo(() => {
    const base = remote.data ?? saved;
    return engine && issueId && base ? engine.overlayComments(issueId, base) : base;
  }, [engine, issueId, remote.data, saved, version]);
  return { data, isLoading: remote.isLoading && !data };
}

export const useHistory = (slug: string, issueId: string | undefined) =>
  useQuery({
    queryKey: keys.history(slug, issueId ?? ''),
    queryFn: () => api.get<HistoryEntry[]>(wsPath(slug, `/issues/${issueId}/history`)),
    enabled: !!issueId,
  });

export const useNotifications = (slug: string, snoozed = false) =>
  useQuery({
    queryKey: [...keys.notifications(slug), snoozed ? 'snoozed' : 'inbox'],
    queryFn: () =>
      api.get<Notification[]>(wsPath(slug, `/notifications${snoozed ? '?snoozed=1' : ''}`)),
  });

export const useProjectUpdates = (slug: string, projectId: string) =>
  useQuery({
    queryKey: keys.projectUpdates(slug, projectId),
    queryFn: () => api.get<ProjectUpdate[]>(wsPath(slug, `/projects/${projectId}/updates`)),
  });

export const useInvites = (slug: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.invites(slug),
    queryFn: () => api.get<Invite[]>(wsPath(slug, '/invites')),
    enabled,
  });

export const useAccount = () =>
  useQuery({ queryKey: keys.account, queryFn: () => api.get<Account>('/me/account') });

export const useSessions = () =>
  useQuery({ queryKey: keys.sessions, queryFn: () => api.get<SessionInfo[]>('/me/sessions') });

export const useApiKeys = () =>
  useQuery({ queryKey: keys.apiKeys, queryFn: () => api.get<ApiKey[]>('/me/api-keys') });

export const useOAuthGrants = () =>
  useQuery({
    queryKey: keys.oauthGrants,
    queryFn: () => api.get<OAuthGrant[]>('/me/oauth-grants'),
  });

export const useSearch = (slug: string, q: string) =>
  useQuery({
    queryKey: keys.search(slug, q),
    queryFn: () => api.get<SearchResults>(wsPath(slug, `/search?q=${encodeURIComponent(q)}`)),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });

// ─── issue mutations with optimistic cache updates ─────────────────────

function applyPatch(issue: Issue, patch: UpdateIssueInput): Issue {
  const next = { ...issue } as Issue & Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === 'addLabelIds' || k === 'removeLabelIds' || k === 'teamId')
      continue;
    next[k] = v;
  }
  if (patch.addLabelIds) next.labelIds = [...new Set([...next.labelIds, ...patch.addLabelIds])];
  if (patch.removeLabelIds)
    next.labelIds = next.labelIds.filter((l) => !patch.removeLabelIds!.includes(l));
  return next;
}

function patchCaches(qc: QueryClient, slug: string, ids: string[], patch: UpdateIssueInput) {
  const idSet = new Set(ids);
  qc.setQueriesData<Issue[]>({ queryKey: ['ws', slug, 'issues'] }, (list) =>
    list?.map((i) => (idSet.has(i.id) ? applyPatch(i, patch) : i)),
  );
  qc.setQueriesData<IssueDetail>({ queryKey: keys.issue(slug) }, (d) =>
    d && idSet.has(d.id) ? ({ ...applyPatch(d, patch), subIssues: d.subIssues } as IssueDetail) : d,
  );
}

export function invalidateIssues(qc: QueryClient, slug: string) {
  qc.invalidateQueries({ queryKey: ['ws', slug, 'issues'] });
  qc.invalidateQueries({ queryKey: keys.issue(slug) });
  qc.invalidateQueries({ queryKey: ['ws', slug, 'history'] });
  qc.invalidateQueries({ queryKey: keys.bootstrap(slug) });
}

const onError = (err: unknown) =>
  toast.error(err instanceof Error ? err.message : t('common.error'));

export function useUpdateIssue(slug: string) {
  const qc = useQueryClient();
  const engine = useSyncEngine();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateIssueInput }) =>
      engine
        ? engine.mutate({ kind: 'issue.update', ids: [id], patch })
        : api.patch<Issue>(wsPath(slug, `/issues/${id}`), patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ['ws', slug, 'issues'] });
      patchCaches(qc, slug, [id], patch);
    },
    onError: (err) => {
      onError(err);
      invalidateIssues(qc, slug);
    },
    onSettled: () => invalidateIssues(qc, slug),
  });
}

export function useBatchUpdateIssues(slug: string) {
  const qc = useQueryClient();
  const engine = useSyncEngine();
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: UpdateIssueInput }) =>
      engine
        ? engine.mutate({ kind: 'issue.update', ids, patch })
        : api.post<Issue[]>(wsPath(slug, '/issues/batch'), { ids, patch }),
    onMutate: async ({ ids, patch }) => {
      await qc.cancelQueries({ queryKey: ['ws', slug, 'issues'] });
      patchCaches(qc, slug, ids, patch);
    },
    onError,
    onSettled: () => invalidateIssues(qc, slug),
  });
}

export function useCreateIssue(slug: string) {
  const qc = useQueryClient();
  const engine = useSyncEngine();
  return useMutation({
    mutationFn: async (input: CreateIssueInput): Promise<Issue> => {
      if (!engine) return api.post<Issue>(wsPath(slug, '/issues'), input);
      // Its id is ours to choose, so it can be shown (and changed) before the server numbers it.
      const id = crypto.randomUUID();
      const sent = await engine.mutate({ kind: 'issue.create', issue: { ...input, id } });
      return (sent as Issue | undefined) ?? engine.issue(id)!;
    },
    onError,
    onSuccess: () => invalidateIssues(qc, slug),
  });
}

export function useTrashIssues(slug: string) {
  const qc = useQueryClient();
  const engine = useSyncEngine();
  return useMutation({
    mutationFn: (ids: string[]) =>
      engine
        ? engine.mutate({ kind: 'issue.trash', ids })
        : api.post(wsPath(slug, '/issues/batch-delete'), { ids }),
    onMutate: async (ids) => {
      const set = new Set(ids);
      qc.setQueriesData<Issue[]>({ queryKey: ['ws', slug, 'issues'] }, (list) =>
        list?.filter((i) => !set.has(i.id)),
      );
    },
    onError,
    onSettled: () => invalidateIssues(qc, slug),
  });
}

/** Generic mutation that refreshes the workspace afterwards. */
/** Adds or removes the signed-in user's reaction, showing it at once. */
export function useToggleReaction(slug: string, issueId: string, userId: string) {
  const qc = useQueryClient();
  const engine = useSyncEngine();
  const key = keys.comments(slug, issueId);
  const apply = (commentId: string, update: (r: CommentReaction[]) => CommentReaction[]) =>
    qc.setQueryData<Comment[]>(key, (list) =>
      list?.map((c) => (c.id === commentId ? { ...c, reactions: update(c.reactions) } : c)),
    );
  return useMutation({
    mutationFn: ({ commentId, emoji, on }: { commentId: string; emoji: string; on: boolean }) => {
      if (engine)
        return engine.mutate({ kind: 'reaction', commentId, issueId, emoji, on }) as Promise<
          CommentReaction[] | undefined
        >;
      const path = wsPath(slug, `/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`);
      return on ? api.put<CommentReaction[]>(path) : api.del<CommentReaction[]>(path);
    },
    onMutate: async ({ commentId, emoji, on }) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<Comment[]>(key);
      apply(commentId, (reactions) => {
        const rest = reactions.map((r) =>
          r.emoji === emoji ? { ...r, userIds: r.userIds.filter((u) => u !== userId) } : r,
        );
        const next = on
          ? rest.some((r) => r.emoji === emoji)
            ? rest.map((r) => (r.emoji === emoji ? { ...r, userIds: [...r.userIds, userId] } : r))
            : [...rest, { emoji, userIds: [userId] }]
          : rest;
        return next.filter((r) => r.userIds.length > 0);
      });
      return { before };
    },
    // Queued (offline) leaves the optimistic version showing.
    onSuccess: (reactions, { commentId }) => {
      if (reactions) apply(commentId, () => reactions);
    },
    onError: (err, _vars, saved) => {
      if (saved?.before) qc.setQueryData(key, saved.before);
      onError(err);
    },
  });
}

export function useWsMutation<TVars, TResult = unknown>(
  slug: string,
  fn: (vars: TVars) => Promise<TResult>,
  opts: { success?: string; invalidate?: readonly unknown[][] } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onError,
    onSuccess: () => {
      if (opts.success) toast.success(opts.success);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.bootstrap(slug) });
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
    },
  });
}

/**
 * Uploads a file as an attachment. With an issue it's attached right away; without one (a new
 * issue) the server keeps it for the uploader until the saved description references it.
 */
export function useAttachmentUpload(slug: string, issueId?: string) {
  const qc = useQueryClient();
  return useCallback(
    async (file: File) => {
      const query = issueId ? `?issueId=${encodeURIComponent(issueId)}` : '';
      const att = await upload<Attachment>(wsPath(slug, `/attachments${query}`), file, file.name);
      if (issueId) qc.invalidateQueries({ queryKey: keys.issue(slug, issueId) });
      return att;
    },
    [slug, issueId, qc],
  );
}

/** The Markdown that shows an attachment: inline for images, a link for anything else. */
export const attachmentMarkdown = (att: Attachment) => {
  const name = att.filename.replace(/[[\]\\]/g, '');
  return att.contentType.startsWith('image/') ? `![${name}](${att.url})` : `[${name}](${att.url})`;
};
