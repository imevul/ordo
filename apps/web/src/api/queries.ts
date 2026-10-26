import type {
  Account,
  ApiKey,
  Attachment,
  Bootstrap,
  Comment,
  CreateIssueInput,
  HistoryEntry,
  InstanceConfig,
  Invite,
  Issue,
  IssueDetail,
  IssueFilter,
  Me,
  Notification,
  ProjectUpdate,
  SearchResults,
  SessionInfo,
  UpdateIssueInput,
} from '@ordo/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { ApiError, api, upload, wsPath } from './client.ts';

export const keys = {
  config: ['config'] as const,
  me: ['me'] as const,
  account: ['account'] as const,
  sessions: ['sessions'] as const,
  apiKeys: ['apiKeys'] as const,
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

export const useConfig = () =>
  useQuery({ queryKey: keys.config, queryFn: () => api.get<InstanceConfig>('/config') });

export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
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

export const useIssues = (slug: string, filter: IssueFilter, enabled = true) =>
  useQuery({
    queryKey: keys.issues(slug, filter),
    queryFn: () => api.post<Issue[]>(wsPath(slug, '/issues/query'), { filter }),
    enabled,
    placeholderData: (prev) => prev,
  });

export const useIssue = (slug: string, id: string | undefined) =>
  useQuery({
    queryKey: keys.issue(slug, id ?? ''),
    queryFn: () => api.get<IssueDetail>(wsPath(slug, `/issues/${id}`)),
    enabled: !!id,
  });

export const useComments = (slug: string, issueId: string | undefined) =>
  useQuery({
    queryKey: keys.comments(slug, issueId ?? ''),
    queryFn: () => api.get<Comment[]>(wsPath(slug, `/issues/${issueId}/comments`)),
    enabled: !!issueId,
  });

export const useHistory = (slug: string, issueId: string | undefined) =>
  useQuery({
    queryKey: keys.history(slug, issueId ?? ''),
    queryFn: () => api.get<HistoryEntry[]>(wsPath(slug, `/issues/${issueId}/history`)),
    enabled: !!issueId,
  });

export const useNotifications = (slug: string) =>
  useQuery({
    queryKey: keys.notifications(slug),
    queryFn: () => api.get<Notification[]>(wsPath(slug, '/notifications')),
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
  toast.error(err instanceof Error ? err.message : 'Something went wrong');

export function useUpdateIssue(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateIssueInput }) =>
      api.patch<Issue>(wsPath(slug, `/issues/${id}`), patch),
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
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: UpdateIssueInput }) =>
      api.post<Issue[]>(wsPath(slug, '/issues/batch'), { ids, patch }),
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
  return useMutation({
    mutationFn: (input: CreateIssueInput) => api.post<Issue>(wsPath(slug, '/issues'), input),
    onError,
    onSuccess: () => invalidateIssues(qc, slug),
  });
}

export function useTrashIssues(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post(wsPath(slug, '/issues/batch-delete'), { ids }),
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
