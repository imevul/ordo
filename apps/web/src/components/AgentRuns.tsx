import type { AgentRun, AgentRunStatus, AgentRunWithIssue, IssueDetail } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bot, ExternalLink, FastForward, RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { t, tx } from '../i18n/index.ts';
import { compactCount, duration, longDate, relativeTime, usd } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Markdown } from './Markdown.tsx';

export const agentRunsKey = (slug: string, issueId: string) =>
  ['ws', slug, 'agentRuns', issueId] as const;

/** One run's page; under agentRuns, so run events refetch it. */
export const agentRunKey = (slug: string, runId: string) =>
  ['ws', slug, 'agentRuns', 'run', runId] as const;

/** A run's status chip, linking to the run's page. */
export function RunStatusLink({ run }: { run: AgentRun }) {
  const ws = useWorkspace();
  return (
    <Link
      to="/$slug/agent-runs/$runId"
      params={{ slug: ws.slug, runId: run.id }}
      className="chip flex-none hover:underline"
      style={{ ['--chip' as string]: RUN_STATUS_COLOR[run.status] }}
      title={t('agents.runsPage.open')}
    >
      {t(`agents.runs.status.${run.status}`)}
    </Link>
  );
}

export const RUN_STATUS_COLOR: Record<AgentRunStatus, string> = {
  queued: 'var(--color-index)',
  claimed: 'var(--color-warning)',
  running: 'var(--color-primary)',
  waiting: 'var(--color-warning)',
  succeeded: 'var(--color-success)',
  failed: 'var(--color-error)',
  cancelled: 'var(--color-muted)',
};

export const isOpenRun = (r: Pick<AgentRun, 'status'>) =>
  r.status === 'queued' ||
  r.status === 'claimed' ||
  r.status === 'running' ||
  r.status === 'waiting';

export const isRestartable = (r: AgentRun) => r.status === 'failed' || r.status === 'cancelled';

/** What a row expands to: the question, what went wrong, or the summary. */
export const runDetail = (r: AgentRun) =>
  r.status === 'waiting'
    ? r.question
    : r.status === 'failed'
      ? (r.error ?? r.summary)
      : (r.summary ?? r.error);

/** Why a failed run failed, and whether it restarts by itself, as tags after its name. */
export function FailureTags({ run }: { run: AgentRun }) {
  return (
    <>
      {run.status === 'failed' && run.failureReason && (
        <span className="tag ml-2 flex-none font-mono" style={{ color: RUN_STATUS_COLOR.failed }}>
          {t(`agents.runs.failure.${run.failureReason}`)}
        </span>
      )}
      {run.retryOfId && (
        <span className="tag ml-2 flex-none font-mono">{t('agents.runs.restarted')}</span>
      )}
    </>
  );
}

/**
 * What a working agent last said it's doing (report_progress), with a bar when it gave a
 * percentage. Gone once the run stops working.
 */
export function RunProgress({ run, className = '' }: { run: AgentRun; className?: string }) {
  const p = run.progress;
  if (!p || (run.status !== 'running' && run.status !== 'claimed')) return null;
  return (
    <div
      className={`flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted ${className}`}
    >
      <span className="min-w-0 truncate" title={longDate(p.at)}>
        {p.step}
      </span>
      {p.percent !== null && (
        <>
          <span
            className="hidden h-[3px] w-16 flex-none bg-border-soft sm:block"
            role="progressbar"
            aria-valuenow={p.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('agents.runs.progress')}
          >
            <span className="block h-full bg-primary" style={{ width: `${p.percent}%` }} />
          </span>
          <span className="flex-none text-index">{p.percent}%</span>
        </>
      )}
      <span className="flex-none text-index">{relativeTime(p.at)}</span>
    </div>
  );
}

/** A queued run held back by its issue's blockers: which ones, linked. */
export function RunBlocked({ run, className = '' }: { run: AgentRun; className?: string }) {
  const ws = useWorkspace();
  if (run.status !== 'queued' || !run.blockedBy.length) return null;
  const issues = run.blockedBy.map((b, i) => (
    <span key={b.id}>
      {i > 0 && ', '}
      <Link
        to="/$slug/issue/$identifier"
        params={{ slug: ws.slug, identifier: b.identifier }}
        className="text-text hover:text-highlight"
        title={b.title}
      >
        {b.identifier}
      </Link>
    </span>
  ));
  return (
    <div className={`truncate font-mono text-[11px] text-warning ${className}`}>
      {tx('agents.runs.waitingOn', { issues: <>{issues}</> })}
    </div>
  );
}

/** A queued run held back by a repository at its run limit. */
export function RunWaitingForSlot({
  run,
  className = '',
}: {
  run: AgentRunWithIssue;
  className?: string;
}) {
  if (!run.waitingForRepository) return null;
  return (
    <div className={`truncate font-mono text-[11px] text-index ${className}`}>
      <span className="text-warning">{t('agents.runsPage.waitingForSlot')}</span>
      {' · '}
      {t('agents.runsPage.waitingForSlotHint', { repository: run.waitingForRepository.name })}
    </div>
  );
}

/** "Run anyway" for a queued run that waits for blockers. */
export function RunAnywayButton({ run, onClick }: { run: AgentRun; onClick: () => void }) {
  if (run.status !== 'queued' || !run.blockedBy.length) return null;
  return (
    <button
      type="button"
      className="flex h-6 w-6 flex-none items-center justify-center text-index hover:text-text"
      onClick={onClick}
      title={t('agents.runs.runAnywayHint')}
      aria-label={t('agents.runs.runAnyway')}
    >
      <FastForward size={12} />
    </button>
  );
}

/** How long a run worked: what its runner said, else from when it started to when it finished. */
export function runDuration(run: AgentRun) {
  if (run.usage?.durationMs != null) return run.usage.durationMs;
  if (!run.startedAt || !run.finishedAt) return null;
  return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

/** What a run used, compactly: "$0.42 · 1.2M tokens · 12m", with the token kinds on hover. */
export function RunUsage({ run, className = '' }: { run: AgentRun; className?: string }) {
  const u = run.usage;
  const time = runDuration(run);
  const tokens = u
    ? (u.inputTokens ?? 0) +
      (u.outputTokens ?? 0) +
      (u.cacheReadTokens ?? 0) +
      (u.cacheWriteTokens ?? 0)
    : 0;
  const parts = [
    u?.costUsd != null ? usd(u.costUsd) : null,
    tokens ? t('agents.usage.tokens', { count: tokens, tokens: compactCount(tokens) }) : null,
    time != null ? duration(time) : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <span
      className={`font-mono text-[11px] text-index ${className}`}
      title={
        u
          ? t('agents.usage.breakdown', {
              input: compactCount(u.inputTokens ?? 0),
              output: compactCount(u.outputTokens ?? 0),
              cacheRead: compactCount(u.cacheReadTokens ?? 0),
              cacheWrite: compactCount(u.cacheWriteTokens ?? 0),
            })
          : undefined
      }
    >
      {parts.join(' · ')}
    </span>
  );
}

/** The expanded row: the agent's question, what went wrong (and what happens next), or its summary. */
export function RunDetail({ run }: { run: AgentRun }) {
  if (run.status === 'waiting' && run.question)
    return (
      <>
        <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-warning uppercase">
          {t('agents.runs.asked')}
        </div>
        <Markdown source={run.question} />
      </>
    );
  if (run.status === 'failed')
    return (
      <>
        {run.failureReason === 'usage_limit' && (
          <p className="mb-1.5 text-[12.5px] text-warning">
            {run.retryAt
              ? t('agents.runs.restartsAt', { time: longDate(run.retryAt) })
              : t('agents.runs.noAutoRestart')}
          </p>
        )}
        <pre className="overflow-x-auto font-mono text-[11.5px] whitespace-pre-wrap text-muted">
          {runDetail(run)}
        </pre>
      </>
    );
  return run.summary ? (
    <Markdown source={run.summary} />
  ) : (
    <pre className="overflow-x-auto font-mono text-[11.5px] whitespace-pre-wrap text-muted">
      {run.error}
    </pre>
  );
}

/**
 * The issue's agent runs: shown while an agent is assigned, or once one has worked on it. Runs
 * change through realtime events (see api/realtime.ts), so nothing polls.
 */
/** Why a run exists, for its tag: "mentioned", or what happened to which pull request. */
export function triggerLabel(run: AgentRun) {
  const pr = run.trigger === 'pull_request' ? run.triggerDetail : null;
  return pr
    ? t(`agents.runs.pullRequest.${pr.event}`, { ref: `#${pr.number}` })
    : t(`agents.runs.trigger.${run.trigger}`);
}

export function AgentRuns({ issue }: { issue: IssueDetail }) {
  const ws = useWorkspace();
  const assignee = issue.assigneeId ? ws.memberById.get(issue.assigneeId) : null;
  const assignedToAgent = assignee?.kind === 'agent';
  const key = agentRunsKey(ws.slug, issue.id);
  const { data: runs = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<AgentRun[]>(wsPath(ws.slug, `/issues/${issue.id}/agent-runs`)),
  });
  const again = useWsMutation(
    ws.slug,
    () => api.post(wsPath(ws.slug, `/issues/${issue.id}/agent-runs`)),
    { invalidate: [key] },
  );
  const cancel = useWsMutation(
    ws.slug,
    (id: string) => api.post(wsPath(ws.slug, `/agent-runs/${id}/cancel`)),
    { invalidate: [key] },
  );
  const restart = useWsMutation(
    ws.slug,
    (id: string) => api.post(wsPath(ws.slug, `/agent-runs/${id}/restart`)),
    { invalidate: [['ws', ws.slug, 'agentRuns']] },
  );
  const anyway = useWsMutation(
    ws.slug,
    (id: string) => api.post(wsPath(ws.slug, `/agent-runs/${id}/run-anyway`)),
    { invalidate: [['ws', ws.slug, 'agentRuns']] },
  );
  if (!assignedToAgent && runs.length === 0) return null;
  const busy = runs.some(isOpenRun);
  // Waiting on an answer: a reply resumes it, and so does this, without one.
  const waiting = runs.some((r) => r.status === 'waiting');

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center gap-3">
        <div className="section-label flex-1">{t('agents.runs.title')}</div>
        {assignedToAgent && (!busy || waiting) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={again.isPending}
            onClick={() => again.mutate(undefined)}
          >
            <RotateCcw size={12} /> {waiting ? t('agents.runs.resume') : t('agents.runs.runAgain')}
          </button>
        )}
      </div>
      {runs.map((r, i) => (
        <RunRow
          key={r.id}
          run={r}
          onCancel={() => cancel.mutate(r.id)}
          onRunAnyway={() => anyway.mutate(r.id)}
          // Newest first: a failed run that a later run of its agent already covers isn't offered.
          onRestart={
            isRestartable(r) && !runs.slice(0, i).some((later) => later.agentId === r.agentId)
              ? () => restart.mutate(r.id)
              : undefined
          }
        />
      ))}
      {runs.length === 0 && (
        <p className="px-2 font-mono text-[12px] text-index">{t('agents.runs.empty')}</p>
      )}
    </section>
  );
}

function RunRow({
  run,
  onCancel,
  onRestart,
  onRunAnyway,
}: {
  run: AgentRun;
  onCancel: () => void;
  onRestart?: () => void;
  onRunAnyway: () => void;
}) {
  const ws = useWorkspace();
  // A question shows by itself (also when a run starts waiting while open) until toggled.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? run.status === 'waiting';
  const agent = ws.memberById.get(run.agentId);
  const color = RUN_STATUS_COLOR[run.status];
  const detail = runDetail(run);
  return (
    <div className="border-b border-border-soft/60">
      <div className="row group flex h-9 items-center gap-2.5 px-2">
        <Bot size={14} className="flex-none" style={{ color }} />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[13.5px]"
          disabled={!detail}
          onClick={() => setToggled(!open)}
          aria-expanded={open}
        >
          {agent?.name ?? t('shell.actor.someone')}
          {run.trigger !== 'assigned' && (
            <span className="tag ml-2 flex-none font-mono">{triggerLabel(run)}</span>
          )}
          <FailureTags run={run} />
          {run.runnerName && (
            <span className="ml-2 font-mono text-[11px] text-index">
              {t('agents.runs.on', { runner: run.runnerName })}
            </span>
          )}
          {run.attempts > 1 && (
            <span className="ml-2 font-mono text-[11px] text-index">
              {t('agents.runs.attempt', { count: run.attempts })}
            </span>
          )}
        </button>
        <RunUsage run={run} className="hidden flex-none md:inline" />
        <RunStatusLink run={run} />
        <span className="hidden flex-none font-mono text-[11px] text-index sm:inline">
          {relativeTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}
        </span>
        {run.sessionUrl && (
          <a
            href={run.sessionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-6 w-6 flex-none items-center justify-center text-index hover:text-highlight"
            title={t('agents.runs.session')}
            aria-label={t('agents.runs.session')}
          >
            <ExternalLink size={13} />
          </a>
        )}
        <RunAnywayButton run={run} onClick={onRunAnyway} />
        {onRestart && (
          <button
            type="button"
            className="flex h-6 w-6 flex-none items-center justify-center text-index hover:text-text"
            onClick={onRestart}
            title={t('agents.runs.restart')}
            aria-label={t('agents.runs.restart')}
          >
            <RotateCcw size={12} />
          </button>
        )}
        {isOpenRun(run) && (
          <button
            type="button"
            className="flex h-6 w-6 flex-none items-center justify-center text-index hover:text-text"
            onClick={onCancel}
            title={t('agents.runs.cancel')}
            aria-label={t('agents.runs.cancel')}
          >
            <Square size={12} />
          </button>
        )}
      </div>
      <RunProgress run={run} className="-mt-1 px-8 pb-2" />
      <RunBlocked run={run} className="-mt-1 px-8 pb-2" />
      {open && detail && (
        <div className="px-8 pb-3 text-[13px]">
          <RunDetail run={run} />
        </div>
      )}
    </div>
  );
}
