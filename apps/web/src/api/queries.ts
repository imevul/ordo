import type {
  Account,
  ApiKey,
  Attachment,
  Bootstrap,
  Comment,
  CommentReaction,
  CreateIssueInput,
  CycleWorkload,
  HistoryEntry,
  InboxFilter,
  InsightsTimeline,
  InstanceConfig,
  Invite,
  Issue,
  IssueDetail,
  IssueFilter,
  Me,
  Notification,
  NotificationType,
  OAuthGrant,
  ProjectUpdate,
  SearchResults,
  SessionInfo,
  UpdateIssueInput,
  Velocity,
} from '@ordo/shared';
import { dayInZone } from '@ordo/shared';
import { type Engine, patchIssue, toggleReaction } from '@ordo/sync';
import {
  keepPreviousData,
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { t } from '../i18n/index.ts';
import { withClock } from '../lib/filters.ts';
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
  workload: (slug: string, cycleId?: string) =>
    cycleId ? (['ws', slug, 'workload', cycleId] as const) : (['ws', slug, 'workload'] as const),
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

/** Today in `tz`, checked every minute; undefined without a zone. */
function useDay(tz: string | undefined) {
  const [day, setDay] = useState(() => (tz ? dayInZone(tz) : undefined));
  useEffect(() => {
    if (!tz) return setDay(undefined);
    setDay(dayInZone(tz));
    const timer = setInterval(() => setDay(dayInZone(tz)), 60_000);
    return () => clearInterval(timer);
  }, [tz]);
  return day;
}

/**
 * Every issue matching `filter`. With a local copy (sync), straight from it; otherwise loaded a
 * page at a time, what's loaded showing while the rest arrives. Screens sort and group on their
 * side.
 */
export function useIssues(slug: string, wanted: IssueFilter, enabled = true) {
  const qc = useQueryClient();
  const me = useMe().data;
  // Relative dates ("today", "overdue") follow the viewer's zone and week; the browser's zone
  // stands in until the account has loaded, or when it can't (offline).
  const relative = withClock(wanted, null, undefined) !== wanted;
  const account = useAccount(relative).data;
  const filter = useMemo(
    () => withClock(wanted, account?.preferences.timezone, account?.preferences.weekStartsOn),
    [wanted, account],
  );
  const day = useDay(filter.tz);
  const local = useLocalIssues(filter, me?.id ?? '', day);
  const fromCopy = !!local.issues || local.waiting;
  // With relative dates, a new day is a new list: "today" moves on at midnight.
  const queryKey = day ? ([...keys.issues(slug, filter), day] as const) : keys.issues(slug, filter);
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
  // The server's page with what's still queued on top, as lists show it: a refetch that lands
  // before a queued change is sent doesn't undo it on screen. The copy hears first what the
  // server made of a sent change, so where its issue is newer, its fields win until the refetch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` marks a changed copy
  const fetched = useMemo(() => {
    if (!remote.data || sync.status !== 'on') return remote.data;
    const local = sync.engine.getState().issues.get(remote.data.id);
    const base =
      local && local.updatedAt > remote.data.updatedAt ? { ...remote.data, ...local } : remote.data;
    return sync.engine.overlayIssue(base);
  }, [remote.data, sync, state]);
  const data = fetched ?? copy;
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

/** An inbox filter as `GET /notifications` query parameters. */
export function inboxQuery(f: InboxFilter, snoozed = false) {
  const q = new URLSearchParams();
  if (snoozed) q.set('snoozed', '1');
  for (const k of ['types', 'teams', 'actors', 'priorities', 'reasons'] as const)
    if (f[k]?.length) q.set(k, f[k].join(','));
  if (f.from) q.set('from', f.from);
  if (f.unread) q.set('unread', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const useNotifications = (slug: string, snoozed = false, filter: InboxFilter = {}) =>
  useQuery({
    queryKey: [...keys.notifications(slug), snoozed ? 'snoozed' : 'inbox', filter],
    queryFn: () =>
      api.get<Notification[]>(wsPath(slug, `/notifications${inboxQuery(filter, snoozed)}`)),
    placeholderData: keepPreviousData,
  });

/** Unread notifications in the inbox per type, for the quick filters. */
export const useNotificationCounts = (slug: string) =>
  useQuery({
    queryKey: [...keys.notifications(slug), 'counts'],
    queryFn: () =>
      api.get<Partial<Record<NotificationType, number>>>(wsPath(slug, '/notifications/counts')),
  });

// Under the 'agentRuns' key so realtime agentRun events refetch it.
export const useActiveAgentRunCount = (slug: string, enabled: boolean) =>
  useQuery({
    queryKey: ['ws', slug, 'agentRuns', 'activeCount'],
    queryFn: () => api.get<{ count: number }>(wsPath(slug, '/agent-runs/active-count')),
    select: (d) => d.count,
    enabled,
  });

export const useProjectUpdates = (slug: string, projectId: string) =>
  useQuery({
    queryKey: keys.projectUpdates(slug, projectId),
    queryFn: () => api.get<ProjectUpdate[]>(wsPath(slug, `/projects/${projectId}/updates`)),
  });

/** A team, project or cycle (or, with none, the workspace) day by day, rebuilt from history. */
export const useInsightsTimeline = (
  slug: string,
  scope: { teamId?: string; projectId?: string; cycleId?: string; from?: string; to?: string },
  enabled = true,
) =>
  useQuery({
    queryKey: ['ws', slug, 'insights', 'timeline', scope],
    queryFn: () => {
      const q = new URLSearchParams(
        Object.entries(scope).filter((e): e is [string, string] => !!e[1]),
      ).toString();
      return api.get<InsightsTimeline>(wsPath(slug, `/insights/timeline${q ? `?${q}` : ''}`));
    },
    placeholderData: keepPreviousData,
    enabled,
  });

export const useVelocity = (slug: string, teamId: string | undefined) =>
  useQuery({
    queryKey: ['ws', slug, 'insights', 'velocity', teamId],
    queryFn: () => api.get<Velocity>(wsPath(slug, `/insights/velocity?teamId=${teamId}`)),
    enabled: !!teamId,
  });

export const useInvites = (slug: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.invites(slug),
    queryFn: () => api.get<Invite[]>(wsPath(slug, '/invites')),
    enabled,
  });

export const useAccount = (enabled = true) =>
  useQuery({ queryKey: keys.account, queryFn: () => api.get<Account>('/me/account'), enabled });

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

function patchCaches(qc: QueryClient, slug: string, ids: string[], patch: UpdateIssueInput) {
  const idSet = new Set(ids);
  const now = new Date().toISOString();
  qc.setQueriesData<Issue[]>({ queryKey: ['ws', slug, 'issues'] }, (list) =>
    list?.map((i) => (idSet.has(i.id) ? patchIssue(i, patch, now) : i)),
  );
  qc.setQueriesData<IssueDetail>({ queryKey: keys.issue(slug) }, (d) =>
    d && idSet.has(d.id)
      ? ({ ...patchIssue(d, patch, now), subIssues: d.subIssues } as IssueDetail)
      : d,
  );
}

/** Stops list and issue-page fetches in flight, so they don't overwrite an optimistic change. */
const cancelIssueQueries = (qc: QueryClient, slug: string) =>
  Promise.all([
    qc.cancelQueries({ queryKey: ['ws', slug, 'issues'] }),
    qc.cancelQueries({ queryKey: keys.issue(slug) }),
  ]);

export function invalidateIssues(qc: QueryClient, slug: string) {
  qc.invalidateQueries({ queryKey: ['ws', slug, 'issues'] });
  qc.invalidateQueries({ queryKey: keys.issue(slug) });
  qc.invalidateQueries({ queryKey: ['ws', slug, 'history'] });
  qc.invalidateQueries({ queryKey: keys.bootstrap(slug) });
  qc.invalidateQueries({ queryKey: keys.workload(slug) });
}

/** Who has what in a cycle, against their capacity. Online only: capacities live on the server. */
export function useCycleWorkload(slug: string, cycleId: string) {
  return useQuery({
    queryKey: keys.workload(slug, cycleId),
    queryFn: () => api.get<CycleWorkload>(wsPath(slug, `/cycles/${cycleId}/workload`)),
  });
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
      await cancelIssueQueries(qc, slug);
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
      await cancelIssueQueries(qc, slug);
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

/**
 * Takes issues out of the trash (Undo): queued after the trash, so offline it still wins.
 * Resolves with the restored issues, or with undefined when the restore is queued to be sent later.
 */
export function useRestoreIssues(slug: string) {
  const qc = useQueryClient();
  const engine = useSyncEngine();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (engine)
        return (await engine.mutate({ kind: 'issue.restore', ids })) as Issue[] | undefined;
      const restored: Issue[] = [];
      for (const id of ids)
        restored.push(await api.post<Issue>(wsPath(slug, `/issues/${id}/restore`)));
      return restored;
    },
    // Out of the trash at once (the trash list comes from the server, and may not answer).
    onMutate: async (ids) => {
      await cancelIssueQueries(qc, slug);
      const set = new Set(ids);
      qc.setQueriesData<Issue[]>(
        {
          queryKey: ['ws', slug, 'issues'],
          predicate: (q) => !!(q.queryKey[3] as IssueFilter | undefined)?.trashed,
        },
        (list) => list?.filter((i) => !set.has(i.id)),
      );
    },
    onError,
    onSettled: () => invalidateIssues(qc, slug),
  });
}

/**
 * Moves issues to another team. Resolves with the moved issues (renumbered), or with undefined
 * when the move is queued to be sent later.
 */
export function useMoveIssues(slug: string) {
  const qc = useQueryClient();
  const engine = useSyncEngine();
  return useMutation({
    mutationFn: async ({ ids, teamId }: { ids: string[]; teamId: string }) => {
      if (engine)
        return (await engine.mutate({ kind: 'issue.move', ids, teamId })) as Issue[] | undefined;
      const moved: Issue[] = [];
      for (const id of ids)
        moved.push(await api.patch<Issue>(wsPath(slug, `/issues/${id}`), { teamId }));
      return moved;
    },
    onMutate: () => cancelIssueQueries(qc, slug),
    onError,
    onSettled: () => invalidateIssues(qc, slug),
  });
}

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
      apply(commentId, (reactions) => toggleReaction(reactions, emoji, userId, on));
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

/** Generic mutation that refreshes the workspace afterwards. */
export function useWsMutation<TVars, TResult = unknown>(
  slug: string,
  fn: (vars: TVars) => Promise<TResult>,
  opts: { success?: string; invalidate?: readonly QueryKey[] } = {},
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
