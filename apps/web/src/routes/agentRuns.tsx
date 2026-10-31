import type { AgentPause, AgentRunWithIssue, AgentUsageTotal } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ExternalLink, Pause, Play, RotateCcw, Square, X } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { keys, useWsMutation } from '../api/queries.ts';
import {
  FailureTags,
  isOpenRun,
  isRestartable,
  RUN_STATUS_COLOR,
  RunAnywayButton,
  RunBlocked,
  RunDetail,
  RunProgress,
  RunUsage,
  runDetail,
  triggerLabel,
} from '../components/AgentRuns.tsx';
import { EmptyState, PageHeader, Sep, Spinner } from '../components/PageHeader.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { getLocale, INTL_TAG, t } from '../i18n/index.ts';
import { compactCount, longDate, relativeTime, usd } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

type Status = 'open' | 'finished' | 'all';
const STATUSES: Status[] = ['open', 'finished', 'all'];
const COLUMNS = 'grid-cols-[9.5rem_minmax(0,1fr)_10rem_10rem_13rem_6rem_4.5rem]';

/**
 * What agents are doing across the workspace: open runs (queued, working, waiting for an answer,
 * or failed and not yet restarted or dismissed) or finished ones. Runs change through realtime
 * events, which refetch this list.
 */
export function AgentRunsPage() {
  const ws = useWorkspace();
  const [status, setStatus] = useState<Status>('open');
  const [agentId, setAgentId] = useState('');
  const agents = ws.members.filter((m) => m.kind === 'agent');
  const paused = ws.workspace.settings.agentRunsPaused;
  const togglePause = useWsMutation(
    ws.slug,
    () => api.patch(wsPath(ws.slug, '/'), { settings: { agentRunsPaused: !paused } }),
    // The workspace's settings come with the signed-in user's workspaces.
    { invalidate: [keys.me] },
  );
  const { data: pauses = [] } = useQuery({
    // Under agentRuns, so the run events that pause an agent refetch it too.
    queryKey: ['ws', ws.slug, 'agentRuns', 'pauses'],
    queryFn: () => api.get<AgentPause[]>(wsPath(ws.slug, '/agent-pauses')),
  });
  const { data: usage = [] } = useQuery({
    // Under agentRuns too: a finished run's report changes the totals.
    queryKey: ['ws', ws.slug, 'agentRuns', 'usage'],
    queryFn: () => api.get<AgentUsageTotal[]>(wsPath(ws.slug, '/agent-usage')),
  });
  const { data: runs } = useQuery({
    queryKey: ['ws', ws.slug, 'agentRuns', 'list', status, agentId],
    queryFn: () =>
      api.get<AgentRunWithIssue[]>(
        wsPath(
          ws.slug,
          `/agent-runs?status=${status}&limit=200${agentId ? `&agentId=${agentId}` : ''}`,
        ),
      ),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('agents.runsPage.kicker')}
          </>
        }
        title={t('agents.runsPage.title')}
        actions={
          <div className="flex items-center gap-2">
            {ws.isAdmin && (
              <button
                type="button"
                className={`btn btn-sm ${paused ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => togglePause.mutate()}
                disabled={togglePause.isPending}
                title={t('agents.runsPage.pauseHint')}
              >
                {paused ? <Play size={12} /> : <Pause size={12} />}
                {paused ? t('agents.runsPage.resume') : t('agents.runsPage.pause')}
              </button>
            )}
            <select
              className="input h-8 w-44"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              aria-label={t('agents.runsPage.agent')}
            >
              <option value="">{t('agents.runsPage.allAgents')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="flex">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`btn btn-sm ${status === s ? 'btn-primary' : 'btn-ghost'}`}
                  aria-pressed={status === s}
                  onClick={() => setStatus(s)}
                >
                  {t(`agents.runsPage.status.${s}`)}
                </button>
              ))}
            </div>
          </div>
        }
      />
      {paused && (
        <div className="border-b border-border-soft bg-warning/10 px-4 py-2 text-[13px] text-warning">
          {t('agents.runsPage.pausedBanner')}
        </div>
      )}
      {pauses.map((p) => (
        <PauseBanner key={p.agentId} pause={p} />
      ))}
      <UsageTotals totals={usage} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!runs ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <EmptyState
            title={
              status === 'open' ? t('agents.runsPage.emptyOpen') : t('agents.runsPage.emptyTitle')
            }
            body={agents.length ? t('agents.runsPage.emptyBody') : t('agents.runsPage.noAgents')}
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
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** An agent on hold (e.g. it hit its usage limit), with "Resume now" for admins. */
function PauseBanner({ pause }: { pause: AgentPause }) {
  const ws = useWorkspace();
  const name = ws.memberById.get(pause.agentId)?.name ?? t('shell.actor.someone');
  const vars = { name, time: longDate(pause.pausedUntil) };
  const unpause = useWsMutation(
    ws.slug,
    () => api.post(wsPath(ws.slug, `/agents/${pause.agentId}/unpause`)),
    { invalidate: [['ws', ws.slug, 'agentRuns']] },
  );
  const budget = pause.reason === 'budget';
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border-soft bg-warning/10 px-4 py-2 text-[13px] text-warning">
      <span className="min-w-0 flex-1">
        {pause.reason === 'usage_limit'
          ? t('agents.runsPage.pausedLimit', vars)
          : budget
            ? t('agents.runsPage.pausedBudget', vars)
            : t('agents.runsPage.paused', vars)}
      </span>
      {ws.isAdmin && budget && (
        <Link
          to="/$slug/settings/$section"
          params={{ slug: ws.slug, section: 'agents' }}
          className="btn btn-ghost btn-sm flex-none"
        >
          {t('agents.runsPage.raiseBudget')}
        </Link>
      )}
      {ws.isAdmin && (
        <button
          type="button"
          className="btn btn-ghost btn-sm flex-none"
          onClick={() => unpause.mutate(undefined)}
          disabled={unpause.isPending}
          title={
            budget ? t('agents.runsPage.resumeBudgetHint') : t('agents.runsPage.resumeNowHint')
          }
        >
          <Play size={12} /> {t('agents.runsPage.resumeNow')}
        </button>
      )}
    </div>
  );
}

/**
 * This month's totals per agent (on issues the reader can see): cost, tokens and runs, with a
 * bar towards the budget when the agent has one.
 */
function UsageTotals({ totals }: { totals: AgentUsageTotal[] }) {
  const ws = useWorkspace();
  const shown = totals.filter((u) => u.runs > 0 || u.budgetUsd !== null);
  if (!shown.length) return null;
  const month = new Date().toLocaleDateString(INTL_TAG[getLocale()], {
    month: 'long',
    timeZone: 'UTC',
  });
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border-soft px-4 py-2.5">
      <span className="kicker">{t('agents.usage.thisMonth', { month })}</span>
      {shown.map((u) => {
        const agent = ws.memberById.get(u.agentId);
        const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
        const share = u.budgetUsd ? Math.min(100, (u.costUsd / u.budgetUsd) * 100) : null;
        return (
          <span
            key={u.agentId}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
          >
            {agent && <Avatar name={agent.name} color={agent.avatarColor} size={16} />}
            <span className="truncate">{agent?.name ?? t('shell.actor.someone')}</span>
            <span className="font-mono text-[12px] whitespace-nowrap text-text">
              {u.budgetUsd !== null
                ? t('agents.usage.ofBudget', { cost: usd(u.costUsd), budget: usd(u.budgetUsd) })
                : usd(u.costUsd)}
            </span>
            {share !== null && (
              <span
                className="h-[3px] w-14 flex-none bg-border-soft"
                role="meter"
                aria-valuenow={Math.round(share)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('agents.usage.budget')}
              >
                <span
                  className={`block h-full ${share >= 100 ? 'bg-warning' : 'bg-primary'}`}
                  style={{ width: `${share}%` }}
                />
              </span>
            )}
            <span className="font-mono text-[11px] whitespace-nowrap text-index">
              {t('agents.usage.tokens', { count: tokens, tokens: compactCount(tokens) })} ·{' '}
              {t('agents.usage.runs', { count: u.runs })}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function RunRow({ run }: { run: AgentRunWithIssue }) {
  const ws = useWorkspace();
  // A question, or what went wrong, shows by itself until toggled.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (run.status === 'waiting' || run.status === 'failed');
  const agent = ws.memberById.get(run.agentId);
  const color = RUN_STATUS_COLOR[run.status];
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
          <span className="chip" style={{ ['--chip' as string]: color }}>
            {t(`agents.runs.status.${run.status}`)}
          </span>
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
          {run.status === 'waiting' && (
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
      <RunBlocked run={run} className="-mt-1.5 pb-2 pl-[11.5rem] pr-4" />
      {run.waitingForRepository && (
        <div className="-mt-1.5 truncate pb-2 pl-[11.5rem] pr-4 font-mono text-[11px] text-index">
          <span className="text-warning">{t('agents.runsPage.waitingForSlot')}</span>
          {' · '}
          {t('agents.runsPage.waitingForSlotHint', {
            repository: run.waitingForRepository.name,
          })}
        </div>
      )}
      {open && detail && (
        <div className="pb-3 pl-[11.5rem] pr-4 text-[13px]">
          <RunDetail run={run} />
        </div>
      )}
    </div>
  );
}
