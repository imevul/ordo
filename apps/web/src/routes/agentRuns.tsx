import type { AgentRunWithIssue } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ExternalLink, Pause, Play, RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { isOpenRun, RUN_STATUS_COLOR, triggerLabel } from '../components/AgentRuns.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { EmptyState, PageHeader, Sep, Spinner } from '../components/PageHeader.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { t } from '../i18n/index.ts';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

type Status = 'active' | 'finished' | 'all';
const STATUSES: Status[] = ['active', 'finished', 'all'];
const COLUMNS = 'grid-cols-[9.5rem_minmax(0,1fr)_10rem_10rem_6rem_4.5rem]';

/**
 * What agents are doing across the workspace: active runs (queued, working, waiting for an
 * answer) or finished ones. Runs change through realtime events, which refetch this list.
 */
export function AgentRunsPage() {
  const ws = useWorkspace();
  const [status, setStatus] = useState<Status>('active');
  const [agentId, setAgentId] = useState('');
  const agents = ws.members.filter((m) => m.kind === 'agent');
  const paused = ws.workspace.settings.agentRunsPaused;
  const togglePause = useWsMutation(ws.slug, () =>
    api.patch(wsPath(ws.slug, '/'), { settings: { agentRunsPaused: !paused } }),
  );
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!runs ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <EmptyState
            title={
              status === 'active'
                ? t('agents.runsPage.emptyActive')
                : t('agents.runsPage.emptyTitle')
            }
            body={agents.length ? t('agents.runsPage.emptyBody') : t('agents.runsPage.noAgents')}
          />
        ) : (
          <div className="min-w-[860px]">
            <div
              className={`grid ${COLUMNS} items-center gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase`}
            >
              <span>{t('agents.runsPage.columns.status')}</span>
              <span>{t('agents.runsPage.columns.issue')}</span>
              <span>{t('agents.runsPage.columns.agent')}</span>
              <span>{t('agents.runsPage.columns.runner')}</span>
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

function RunRow({ run }: { run: AgentRunWithIssue }) {
  const ws = useWorkspace();
  // A question shows by itself (also when a run starts waiting while open) until toggled.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? run.status === 'waiting';
  const agent = ws.memberById.get(run.agentId);
  const color = RUN_STATUS_COLOR[run.status];
  const detail = run.status === 'waiting' ? run.question : (run.summary ?? run.error);
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
      {open && detail && (
        <div className="pb-3 pl-[11.5rem] pr-4 text-[13px]">
          {run.status === 'waiting' ? (
            <>
              <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-warning uppercase">
                {t('agents.runs.asked')}
              </div>
              <Markdown source={detail} />
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
