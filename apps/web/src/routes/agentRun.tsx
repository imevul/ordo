import {
  AGENT_LEASE_MS,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunEvent,
} from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ExternalLink, FastForward, RotateCcw, Square, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import {
  agentRunKey,
  FailureTags,
  isOpenRun,
  isRestartable,
  RUN_STATUS_COLOR,
  RunBlocked,
  RunProgress,
  triggerLabel,
} from '../components/AgentRuns.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { EmptyState, PageHeader, Sep, Spinner } from '../components/PageHeader.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { t, tx } from '../i18n/index.ts';
import { durationBetween, longDate, relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

/**
 * One run, the whole story: what it was asked and why, each step it went through, how it ended
 * and what restarted it. Run events refetch it (realtime invalidates every agentRuns query).
 */
export function AgentRunPage() {
  const ws = useWorkspace();
  const { runId } = useParams({ from: '/$slug/agent-runs/$runId' });
  const { data: run, isError } = useQuery({
    queryKey: agentRunKey(ws.slug, runId),
    queryFn: () => api.get<AgentRunDetail>(wsPath(ws.slug, `/agent-runs/${runId}`)),
    retry: false,
  });
  if (isError) return <EmptyState title={t('agents.runPage.notFound')} />;
  if (!run) return <Spinner />;
  const agent = ws.memberById.get(run.agentId);
  const agentName = agent?.name ?? t('shell.actor.someone');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            <Link
              to="/$slug/agent-runs"
              params={{ slug: ws.slug }}
              className="hover:text-highlight"
            >
              {t('agents.runsPage.kicker')}
            </Link>
            <Sep />
            {t('agents.runPage.kicker')} {run.id.slice(0, 8)}
          </>
        }
        title={t('agents.runPage.title', { name: agentName, identifier: run.issue.identifier })}
        actions={<RunActions run={run} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-10 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-y-1">
              <span className="chip" style={{ ['--chip' as string]: RUN_STATUS_COLOR[run.status] }}>
                {t(`agents.runs.status.${run.status}`)}
              </span>
              <FailureTags run={run} />
            </div>
            <Link
              to="/$slug/issue/$identifier"
              params={{ slug: ws.slug, identifier: run.issue.identifier }}
              className="mt-3 flex min-w-0 items-baseline gap-2 hover:text-highlight"
            >
              <span className="flex-none font-mono text-[12px] text-index">
                {run.issue.identifier}
              </span>
              <span className="text-[20px] font-semibold tracking-[-0.01em]">
                {run.issue.title}
              </span>
            </Link>
            <RunBlocked run={run} className="mt-3 text-[12px] whitespace-normal" />
            <Restarts run={run} />
            {run.progress && (run.status === 'running' || run.status === 'claimed') && (
              <>
                <div className="section-label mt-6 mb-2">{t('agents.runPage.progress')}</div>
                <RunProgress run={run} className="text-[12.5px]" />
              </>
            )}
            <Result run={run} />
            <div className="section-label mt-8 mb-2">{t('agents.runPage.timeline')}</div>
            <Timeline run={run} />
            <Prompt prompt={run.prompt} />
          </div>
          <Details run={run} />
        </div>
      </div>
    </div>
  );
}

/** Resume, Restart, Dismiss, Cancel: whichever the run's state allows. */
function RunActions({ run }: { run: AgentRunDetail }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
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
    () => api.post<AgentRun>(wsPath(ws.slug, `/agent-runs/${run.id}/restart`)),
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
    <>
      {run.status === 'queued' && run.blockedBy.length > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={anyway.isPending}
          onClick={() => anyway.mutate(undefined)}
          title={t('agents.runs.runAnywayHint')}
        >
          <FastForward size={12} /> {t('agents.runs.runAnyway')}
        </button>
      )}
      {run.status === 'waiting' && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={resume.isPending}
          onClick={() => resume.mutate(undefined)}
        >
          <RotateCcw size={12} /> {t('agents.runs.resume')}
        </button>
      )}
      {/* A restart that's still going already covers it. */}
      {isRestartable(run) && !run.restartedBy.some((r) => isOpenRun(r)) && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={restart.isPending}
          onClick={() =>
            restart.mutate(undefined, {
              // The restart is a run of its own: follow it there.
              onSuccess: (next) =>
                navigate({
                  to: '/$slug/agent-runs/$runId',
                  params: { slug: ws.slug, runId: next.id },
                }),
            })
          }
        >
          <RotateCcw size={12} /> {t('agents.runs.restart')}
        </button>
      )}
      {run.status === 'failed' && !run.dismissedAt && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate(undefined)}
        >
          <X size={12} /> {t('agents.runs.dismiss')}
        </button>
      )}
      {isOpenRun(run) && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(undefined)}
        >
          <Square size={12} /> {t('agents.runs.cancel')}
        </button>
      )}
    </>
  );
}

const runLink = (slug: string, runId: string, children: ReactNode) => (
  <Link
    to="/$slug/agent-runs/$runId"
    params={{ slug, runId }}
    className="text-highlight hover:underline"
  >
    {children}
  </Link>
);

/** Which run this one restarts, and which runs restarted it. */
function Restarts({ run }: { run: AgentRunDetail }) {
  const ws = useWorkspace();
  if (!run.retryOfId && run.restartedBy.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-1.5 text-[13px] text-muted">
      {run.retryOfId && (
        <p>
          {tx('agents.runPage.restarts', {
            a: (s) => runLink(ws.slug, run.retryOfId!, s),
          })}
        </p>
      )}
      {run.restartedBy.length > 0 && (
        <p className="flex flex-wrap items-center gap-2">
          {t('agents.runPage.restartedBy')}
          {run.restartedBy.map((r) => (
            <Link
              key={r.id}
              to="/$slug/agent-runs/$runId"
              params={{ slug: ws.slug, runId: r.id }}
              className="flex items-center gap-1.5 hover:text-highlight"
            >
              <span className="font-mono text-[11.5px]">{r.id.slice(0, 8)}</span>
              <span className="chip" style={{ ['--chip' as string]: RUN_STATUS_COLOR[r.status] }}>
                {t(`agents.runs.status.${r.status}`)}
              </span>
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}

/** How it ended: the summary, the error and what happens next after a usage limit. */
function Result({ run }: { run: AgentRunDetail }) {
  const finished = !isOpenRun(run);
  if (!finished && !run.summary && !run.error) return null;
  return (
    <>
      <div className="section-label mt-8 mb-2">{t('agents.runPage.result')}</div>
      {run.status === 'failed' && run.failureReason === 'usage_limit' && (
        <p className="mb-2 text-[12.5px] text-warning">
          {run.retryAt
            ? t('agents.runs.restartsAt', { time: longDate(run.retryAt) })
            : t('agents.runs.noAutoRestart')}
        </p>
      )}
      {run.summary && (
        <div className="panel mb-3 p-3 text-[13.5px]">
          <Markdown source={run.summary} />
        </div>
      )}
      {run.error && (
        <>
          <div className="kicker mb-1 text-[10.5px] tracking-[0.14em] uppercase">
            {t('agents.runPage.error')}
          </div>
          <pre className="panel overflow-x-auto p-3 font-mono text-[11.5px] whitespace-pre-wrap text-muted">
            {run.error}
          </pre>
        </>
      )}
      {!run.summary && !run.error && (
        <p className="font-mono text-[12px] text-index">{t('agents.runPage.noResult')}</p>
      )}
    </>
  );
}

/** The run's steps, oldest first; runs from before timelines were kept get their times only. */
function Timeline({ run }: { run: AgentRunDetail }) {
  const ws = useWorkspace();
  const events: AgentRunEvent[] = run.events.length ? run.events : fallbackEvents(run);
  const working = run.status === 'claimed' || run.status === 'running';
  return (
    <>
      {run.events.length === 0 && (
        <p className="mb-2 font-mono text-[12px] text-index">{t('agents.runPage.noTimeline')}</p>
      )}
      <ol className="border-l border-border-soft">
        {events.map((e) => {
          const actor = e.actorId ? ws.memberById.get(e.actorId) : null;
          return (
            <li key={e.id} className="relative pb-3 pl-4">
              <span
                className="absolute top-[7px] -left-[3.5px] h-[6px] w-[6px]"
                style={{ background: eventColor(e) }}
              />
              <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span>{eventLabel(e)}</span>
                <span className="font-mono text-[11px] text-index">
                  {actor?.name ??
                    (e.actorId ? t('shell.actor.someone') : t('agents.runPage.system'))}{' '}
                  · {longDate(e.at)}
                </span>
              </div>
              <EventBody event={e} />
            </li>
          );
        })}
        {working && run.leaseExpiresAt && (
          <li className="relative pl-4 font-mono text-[11.5px] text-index">
            <span className="absolute top-[6px] -left-[3.5px] h-[6px] w-[6px] animate-pulse bg-primary" />
            {t('agents.runPage.leaseUntil', { time: longDate(run.leaseExpiresAt) })} ·{' '}
            {t('agents.runPage.heartbeat', { time: lastHeartbeat(run.leaseExpiresAt) })}
          </li>
        )}
      </ol>
    </>
  );
}

const lastHeartbeat = (leaseExpiresAt: string) =>
  relativeTime(new Date(Date.parse(leaseExpiresAt) - AGENT_LEASE_MS).toISOString());

function fallbackEvents(run: AgentRunDetail): AgentRunEvent[] {
  const at = (id: string, kind: AgentRunEvent['kind'], time: string | null) =>
    time ? [{ id, kind, at: time, data: {}, actorId: null }] : [];
  const end =
    run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
      ? run.status
      : null;
  return [
    ...at('queued', 'queued', run.createdAt),
    ...at('started', 'started', run.startedAt),
    ...(end ? at('end', end, run.finishedAt) : []),
  ];
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function eventLabel(e: AgentRunEvent): string {
  const runner = str(e.data.runner);
  const attempt = typeof e.data.attempt === 'number' ? e.data.attempt : 1;
  switch (e.kind) {
    case 'queued':
      return e.data.retryOfId
        ? t('agents.runPage.event.queuedRestart')
        : t('agents.runPage.event.queued');
    case 'claimed':
      return runner
        ? t('agents.runPage.event.claimed', { runner, attempt })
        : t('agents.runPage.event.claimedNoRunner', { attempt });
    case 'resumed':
      return e.data.commentId
        ? t('agents.runPage.event.resumed')
        : t('agents.runPage.event.resumedNoAnswer');
    case 'lapsed':
      if (e.data.failed)
        return runner
          ? t('agents.runPage.event.lapsedFailed', { runner })
          : t('agents.runPage.event.lapsedFailedNoRunner');
      return runner
        ? t('agents.runPage.event.lapsed', { runner })
        : t('agents.runPage.event.lapsedNoRunner');
    default:
      return t(`agents.runPage.event.${e.kind}`);
  }
}

function eventColor(e: AgentRunEvent) {
  switch (e.kind) {
    case 'succeeded':
      return RUN_STATUS_COLOR.succeeded;
    case 'failed':
    case 'lapsed':
      return RUN_STATUS_COLOR.failed;
    case 'asked':
      return RUN_STATUS_COLOR.waiting;
    case 'cancelled':
    case 'dismissed':
      return RUN_STATUS_COLOR.cancelled;
    default:
      return 'var(--color-index)';
  }
}

/** What a step says beyond its label: the progress note, the question, why it stopped. */
function EventBody({ event: e }: { event: AgentRunEvent }) {
  if (e.kind === 'progress') {
    const percent = typeof e.data.percent === 'number' ? e.data.percent : null;
    return (
      <div className="mt-0.5 font-mono text-[12px] text-muted">
        {str(e.data.step)}
        {percent !== null && <span className="ml-2 text-index">{percent}%</span>}
      </div>
    );
  }
  if (e.kind === 'asked' && str(e.data.question))
    return (
      <div className="mt-1 border-l-2 border-warning pl-3 text-[13px]">
        <Markdown source={str(e.data.question)!} />
      </div>
    );
  if (e.kind === 'failed' && str(e.data.reason))
    return (
      <span className="tag mt-1 inline-block font-mono" style={{ color: RUN_STATUS_COLOR.failed }}>
        {t(`agents.runs.failure.${e.data.reason as 'error'}`)}
      </span>
    );
  // The server's words for why (Unassigned, the agent was disabled…), unless it's just "Cancelled".
  if (e.kind === 'cancelled' && str(e.data.reason) && e.data.reason !== 'Cancelled')
    return <div className="mt-0.5 font-mono text-[12px] text-muted">{str(e.data.reason)}</div>;
  return null;
}

/** The prompt of the latest pickup, folded away: it's long. */
function Prompt({ prompt }: { prompt: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="mt-8 mb-2 flex items-center gap-3">
        <div className="section-label flex-1">{t('agents.runPage.prompt')}</div>
        {prompt && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? t('agents.runPage.hidePrompt') : t('agents.runPage.showPrompt')}
          </button>
        )}
      </div>
      {!prompt ? (
        <p className="font-mono text-[12px] text-index">{t('agents.runPage.noPrompt')}</p>
      ) : (
        <>
          <p className="mb-2 text-[12.5px] text-muted">{t('agents.runPage.promptHint')}</p>
          {open && (
            <pre className="panel max-h-[32rem] overflow-auto p-3 font-mono text-[11.5px] whitespace-pre-wrap">
              {prompt}
            </pre>
          )}
        </>
      )}
    </>
  );
}

function Details({ run }: { run: AgentRunDetail }) {
  const ws = useWorkspace();
  const agent = ws.memberById.get(run.agentId);
  const requester = run.requestedById ? ws.memberById.get(run.requestedById) : null;
  const commentAuthor = run.triggerComment?.authorId
    ? ws.memberById.get(run.triggerComment.authorId)
    : null;
  const row = (label: string, value: ReactNode) => (
    <div>
      <div className="text-index">{label}</div>
      <div className="mt-0.5 min-w-0 break-words">{value}</div>
    </div>
  );
  return (
    <aside className="min-w-0">
      <div className="section-label mb-3">{t('agents.runPage.details')}</div>
      <div className="flex flex-col gap-3 text-[12.5px]">
        {row(
          t('agents.runPage.agent'),
          <span className="flex items-center gap-2">
            {agent && <Avatar name={agent.name} color={agent.avatarColor} size={16} />}
            {agent?.name ?? t('shell.actor.someone')}
          </span>,
        )}
        {row(t('agents.runPage.trigger'), triggerLabel(run))}
        {run.triggerDetail &&
          row(
            t('agents.runPage.pullRequest'),
            <a
              href={run.triggerDetail.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono hover:text-highlight"
            >
              {run.triggerDetail.repo}#{run.triggerDetail.number}
            </a>,
          )}
        {row(
          t('agents.runPage.requestedBy'),
          requester ? (
            <span className="flex items-center gap-2">
              <Avatar
                name={requester.name}
                color={requester.avatarColor}
                src={requester.avatarUrl}
                size={16}
              />
              {requester.name}
            </span>
          ) : (
            <span className="text-index">{t('agents.runPage.nobody')}</span>
          ),
        )}
        {run.triggerComment &&
          row(
            t('agents.runPage.mentionedIn'),
            <div className="border-l-2 border-border-soft pl-2 text-[12.5px] text-muted">
              {commentAuthor && <div className="mb-1 text-text">{commentAuthor.name}</div>}
              <div className="line-clamp-6">
                <Markdown source={run.triggerComment.body} />
              </div>
            </div>,
          )}
        {row(
          t('agents.runPage.runner'),
          <span className="font-mono">{run.runnerName ?? '—'}</span>,
        )}
        {row(t('agents.runPage.attempts'), <span className="font-mono">{run.attempts}</span>)}
        {row(t('agents.runPage.queuedAt'), longDate(run.createdAt))}
        {run.startedAt && row(t('agents.runPage.startedAt'), longDate(run.startedAt))}
        {run.finishedAt && row(t('agents.runPage.finishedAt'), longDate(run.finishedAt))}
        {run.finishedAt &&
          row(
            t('agents.runPage.took'),
            durationBetween(run.startedAt ?? run.createdAt, run.finishedAt),
          )}
        {run.sessionUrl &&
          row(
            t('agents.runPage.session'),
            <a
              href={run.sessionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 break-all hover:text-highlight"
            >
              <ExternalLink size={12} className="flex-none" />
              {t('agents.runs.session')}
            </a>,
          )}
      </div>
    </aside>
  );
}
