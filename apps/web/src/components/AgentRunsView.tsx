import {
  AGENT_RUN_GROUPS,
  type AgentRunFilter,
  type AgentRunGroup,
  type AgentRunPage,
  type AgentRunWithIssue,
} from '@ordo/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, ExternalLink, RotateCcw, Square, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useAccount, useWsMutation } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { withClock } from '../lib/filters.ts';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import {
  FailureTags,
  isOpenRun,
  isPlanPending,
  isRestartable,
  PlanApprovedTag,
  RunAnywayButton,
  RunDetail,
  RunProgress,
  RunStatusLink,
  RunUsage,
  RunWaitReasons,
  runDetail,
  triggerLabel,
} from './AgentRuns.tsx';
import { FilterButton, FilterChips, hasUserFilters } from './FilterBar.tsx';
import { EmptyState, Spinner } from './PageHeader.tsx';
import { Avatar } from './ui/Avatar.tsx';

/** The lists people choose between. `active` stays an API word: Waiting says more. */
const GROUPS = AGENT_RUN_GROUPS.filter((g) => g !== 'active') as Exclude<AgentRunGroup, 'active'>[];
const COLUMNS = 'grid-cols-[9.5rem_minmax(0,1fr)_10rem_10rem_13rem_6rem_4.5rem]';
const PAGE = 100;
/** Pauses and cycle dates lapse with no event to say so. */
const REFRESH_MS = 60_000;

export interface AgentRunsScope {
  filter: AgentRunFilter;
  group: AgentRunGroup;
  teamId?: string;
}

/**
 * Group buttons, team and Filter: what chooses the runs. A row of its own, since all of it doesn't
 * fit a page's header on a phone.
 */
export function AgentRunsControls({
  scope,
  onChange,
}: {
  scope: AgentRunsScope;
  onChange: (next: AgentRunsScope) => void;
}) {
  const ws = useWorkspace();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-soft px-4 py-2">
      {ws.teams.length > 1 && (
        <select
          className="input h-8 w-36"
          value={scope.teamId ?? ''}
          onChange={(e) => onChange({ ...scope, teamId: e.target.value || undefined })}
          aria-label={t('agents.runsPage.team')}
        >
          <option value="">{t('agents.runsPage.allTeams')}</option>
          {ws.teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      )}
      <FilterButton
        scope="agentRuns"
        filter={scope.filter}
        teamId={scope.teamId}
        onChange={(filter) => onChange({ ...scope, filter })}
      />
      <div className="flex">
        {GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            className={`btn btn-sm ${scope.group === g ? 'btn-primary' : 'btn-ghost'}`}
            aria-pressed={scope.group === g}
            onClick={() => onChange({ ...scope, group: g })}
          >
            {t(`agents.runsPage.status.${g}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The chips and the runs they choose, a page at a time. Runs change through realtime events, which
 * refetch what's loaded.
 */
export function AgentRunsList({
  scope,
  onChange,
}: {
  scope: AgentRunsScope;
  onChange: (next: AgentRunsScope) => void;
}) {
  const ws = useWorkspace();
  const { filter, group, teamId } = scope;
  // Relative dates ("today") follow the viewer's zone and week, as issue lists do.
  const relative = withClock(filter, null, undefined) !== filter;
  const account = useAccount(relative).data;
  const clocked = useMemo(
    () => withClock(filter, account?.preferences.timezone, account?.preferences.weekStartsOn),
    [filter, account],
  );
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['ws', ws.slug, 'agentRuns', 'list', group, teamId ?? null, clocked],
    queryFn: ({ pageParam }) =>
      api.post<AgentRunPage>(wsPath(ws.slug, '/agent-runs/query'), {
        filter: clocked,
        group,
        teamId,
        limit: PAGE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, offset) => (last.hasMore ? offset + PAGE : undefined),
    refetchInterval: REFRESH_MS,
  });
  // A run that moved up between pages comes back on the next one.
  const runs = useMemo(() => {
    if (!data) return undefined;
    const byId = new Map<string, AgentRunWithIssue>();
    for (const r of data.pages.flatMap((p) => p.runs)) if (!byId.has(r.id)) byId.set(r.id, r);
    return [...byId.values()];
  }, [data]);
  const hasAgents = ws.members.some((m) => m.kind === 'agent');
  const filtered = hasUserFilters(filter) || !!teamId;

  return (
    <>
      <FilterChips
        scope="agentRuns"
        filter={filter}
        teamId={teamId}
        onChange={(next) => onChange({ ...scope, filter: next })}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!runs ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <EmptyState
            title={
              filtered
                ? t('agents.runsPage.emptyFiltered')
                : group === 'open'
                  ? t('agents.runsPage.emptyOpen')
                  : group === 'waiting'
                    ? t('agents.runsPage.emptyWaiting')
                    : t('agents.runsPage.emptyTitle')
            }
            body={
              filtered
                ? undefined
                : hasAgents
                  ? t('agents.runsPage.emptyBody')
                  : t('agents.runsPage.noAgents')
            }
          />
        ) : (
          <div className="min-w-[1080px]">
            <div
              className={`grid ${COLUMNS} items-center gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase`}
            >
              <span>{t('agents.runsPage.columns.status')}</span>
              <span>{t('agents.runsPage.columns.issue')}</span>
              <span>{t('agents.runsPage.columns.agent')}</span>
              <span>{t('agents.runsPage.columns.runner')}</span>
              <span>{t('agents.runsPage.columns.usage')}</span>
              <span>{t('agents.runsPage.columns.updated')}</span>
              <span />
            </div>
            {runs
              .filter((r) => group !== 'open' || !r.waitingForCycle)
              .map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            {group === 'open' && <HeldRuns runs={runs.filter((r) => r.waitingForCycle)} />}
            {hasNextPage && (
              <div className="p-3">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={isFetchingNextPage}
                  onClick={() => fetchNextPage()}
                >
                  {t('agents.runsPage.loadMore')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Runs held for a later cycle: work that's planned, so out of the way until asked for. */
function HeldRuns({ runs }: { runs: AgentRunWithIssue[] }) {
  const [open, setOpen] = useState(false);
  if (!runs.length) return null;
  return (
    <>
      <button
        type="button"
        className="flex w-full items-center gap-2 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase hover:text-text"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={12} className={open ? 'rotate-90' : ''} />
        {t('agents.runsPage.waitingForCycles', { count: runs.length })}
      </button>
      {open && runs.map((r) => <RunRow key={r.id} run={r} />)}
    </>
  );
}

function RunRow({ run }: { run: AgentRunWithIssue }) {
  const ws = useWorkspace();
  // A question, or what went wrong, shows by itself until toggled.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (run.status === 'waiting' || run.status === 'failed');
  const agent = ws.memberById.get(run.agentId);
  const detail = runDetail(run);
  const invalidate = { invalidate: [['ws', ws.slug, 'agentRuns']] };
  const resume = useWsMutation(
    ws.slug,
    () => api.post(wsPath(ws.slug, `/issues/${run.issueId}/agent-runs`)),
    invalidate,
  );
  const cancel = useWsMutation(
    ws.slug,
    () => api.post(wsPath(ws.slug, `/agent-runs/${run.id}/cancel`)),
    invalidate,
  );
  const restart = useWsMutation(
    ws.slug,
    () => api.post(wsPath(ws.slug, `/agent-runs/${run.id}/restart`)),
    invalidate,
  );
  const dismiss = useWsMutation(
    ws.slug,
    () => api.post(wsPath(ws.slug, `/agent-runs/${run.id}/dismiss`)),
    invalidate,
  );
  const anyway = useWsMutation(
    ws.slug,
    () => api.post(wsPath(ws.slug, `/agent-runs/${run.id}/run-anyway`)),
    invalidate,
  );
  return (
    <div className="border-b border-border-soft/60">
      <div className={`row grid h-11 ${COLUMNS} items-center gap-3 px-4`}>
        <span>
          <RunStatusLink run={run} />
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <Link
            to="/$slug/issue/$identifier"
            params={{ slug: ws.slug, identifier: run.issue.identifier }}
            className="flex min-w-0 items-center gap-2 hover:text-highlight"
          >
            <span className="flex-none font-mono text-[11.5px] text-index">
              {run.issue.identifier}
            </span>
            <span className="truncate text-[13.5px]">{run.issue.title}</span>
          </Link>
          {/* The issue column is narrow below xl; the expanded row says what failed anyway. */}
          <span className="hidden xl:contents">
            <FailureTags run={run} />
            <PlanApprovedTag run={run} />
          </span>
          {detail && (
            <button
              type="button"
              className="flex-none font-mono text-[10.5px] tracking-[0.1em] text-index uppercase hover:text-text"
              aria-expanded={open}
              onClick={() => setToggled(!open)}
            >
              {open ? t('agents.runsPage.less') : t('agents.runsPage.more')}
            </button>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
          {agent && <Avatar name={agent.name} color={agent.avatarColor} size={16} />}
          <span className="truncate">{agent?.name ?? t('shell.actor.someone')}</span>
          {run.trigger !== 'assigned' && (
            <span className="tag ml-2 flex-none font-mono">{triggerLabel(run)}</span>
          )}
        </span>
        <span className="truncate font-mono text-[11.5px] text-index">
          {run.runnerName ?? '—'}
          {run.attempts > 1 && ` · ${t('agents.runs.attempt', { count: run.attempts })}`}
        </span>
        <span className="min-w-0 truncate">
          <RunUsage run={run} />
        </span>
        <span className="font-mono text-[11px] text-index">
          {relativeTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}
        </span>
        <span className="flex items-center justify-end gap-1">
          {run.sessionUrl && (
            <a
              href={run.sessionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-6 w-6 items-center justify-center text-index hover:text-highlight"
              title={t('agents.runs.session')}
              aria-label={t('agents.runs.session')}
            >
              <ExternalLink size={13} />
            </a>
          )}
          {run.status === 'waiting' && !isPlanPending(run) && (
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
              title={t('agents.runs.resume')}
              aria-label={t('agents.runs.resume')}
              disabled={resume.isPending}
              onClick={() => resume.mutate(undefined)}
            >
              <RotateCcw size={12} />
            </button>
          )}
          <RunAnywayButton run={run} onClick={() => anyway.mutate(undefined)} />
          {isRestartable(run) && (
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
              title={t('agents.runs.restart')}
              aria-label={t('agents.runs.restart')}
              disabled={restart.isPending}
              onClick={() => restart.mutate(undefined)}
            >
              <RotateCcw size={12} />
            </button>
          )}
          {run.status === 'failed' && !run.dismissedAt && (
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
              title={t('agents.runs.dismiss')}
              aria-label={t('agents.runs.dismiss')}
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(undefined)}
            >
              <X size={12} />
            </button>
          )}
          {isOpenRun(run) && (
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
              title={t('agents.runs.cancel')}
              aria-label={t('agents.runs.cancel')}
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(undefined)}
            >
              <Square size={12} />
            </button>
          )}
        </span>
      </div>
      <RunProgress run={run} className="-mt-1.5 pb-2 pl-[11.5rem] pr-4" />
      <RunWaitReasons run={run} className="-mt-1.5 pb-2 pl-[11.5rem] pr-4" />
      {open && detail && (
        <div className="pb-3 pl-[11.5rem] pr-4 text-[13px]">
          <RunDetail run={run} />
        </div>
      )}
    </div>
  );
}
