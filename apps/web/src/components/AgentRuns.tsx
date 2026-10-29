import type { AgentRun, AgentRunStatus, IssueDetail } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Bot, ExternalLink, RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Markdown } from './Markdown.tsx';

export const agentRunsKey = (slug: string, issueId: string) =>
  ['ws', slug, 'agentRuns', issueId] as const;

const STATUS_COLOR: Record<AgentRunStatus, string> = {
  queued: 'var(--color-index)',
  claimed: 'var(--color-warning)',
  running: 'var(--color-primary)',
  waiting: 'var(--color-warning)',
  succeeded: 'var(--color-success)',
  failed: 'var(--color-error)',
  cancelled: 'var(--color-muted)',
};

const isOpen = (r: AgentRun) =>
  r.status === 'queued' ||
  r.status === 'claimed' ||
  r.status === 'running' ||
  r.status === 'waiting';

/**
 * The issue's agent runs: shown while an agent is assigned, or once one has worked on it. Runs
 * change through realtime events (see api/realtime.ts), so nothing polls.
 */
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
    { invalidate: [[...key]] },
  );
  const cancel = useWsMutation(
    ws.slug,
    (id: string) => api.post(wsPath(ws.slug, `/agent-runs/${id}/cancel`)),
    { invalidate: [[...key]] },
  );
  if (!assignedToAgent && runs.length === 0) return null;
  const busy = runs.some(isOpen);
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
      {runs.map((r) => (
        <RunRow key={r.id} run={r} onCancel={() => cancel.mutate(r.id)} />
      ))}
      {runs.length === 0 && (
        <p className="px-2 font-mono text-[12px] text-index">{t('agents.runs.empty')}</p>
      )}
    </section>
  );
}

function RunRow({ run, onCancel }: { run: AgentRun; onCancel: () => void }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(run.status === 'waiting');
  const agent = ws.memberById.get(run.agentId);
  const color = STATUS_COLOR[run.status];
  const detail = run.status === 'waiting' ? run.question : (run.summary ?? run.error);
  return (
    <div className="border-b border-border-soft/60">
      <div className="row group flex h-9 items-center gap-2.5 px-2">
        <Bot size={14} className="flex-none" style={{ color }} />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[13.5px]"
          disabled={!detail}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {agent?.name ?? t('shell.actor.someone')}
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
        <span className="chip flex-none" style={{ ['--chip' as string]: color }}>
          {t(`agents.runs.status.${run.status}`)}
        </span>
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
        {isOpen(run) && (
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
      {open && detail && (
        <div className="px-8 pb-3 text-[13px]">
          {run.status === 'waiting' && run.question ? (
            <>
              <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-warning uppercase">
                {t('agents.runs.asked')}
              </div>
              <Markdown source={run.question} />
            </>
          ) : run.summary ? (
            <Markdown source={run.summary} />
          ) : (
            <pre className="overflow-x-auto font-mono text-[11.5px] whitespace-pre-wrap text-muted">
              {run.error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
