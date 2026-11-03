import {
  AGENT_RUN_GROUPS,
  type AgentPause,
  type AgentRunGroup,
  type AgentUsageTotal,
  agentRunFilterSchema,
  DEFAULT_ISSUE_DISPLAY,
} from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Pause, Play, Save } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { keys, useWsMutation } from '../api/queries.ts';
import { AgentRunHoldsPanel } from '../components/AgentRunHolds.tsx';
import {
  AgentRunsControls,
  AgentRunsList,
  type AgentRunsScope,
} from '../components/AgentRunsView.tsx';
import { hasUserFilters } from '../components/FilterBar.tsx';
import { PageHeader, Sep } from '../components/PageHeader.tsx';
import { SaveViewModal } from '../components/SaveViewModal.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { getLocale, INTL_TAG, t } from '../i18n/index.ts';
import { compactCount, longDate, usd } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

export interface AgentRunsSearch {
  group?: AgentRunGroup;
  team?: string;
  filter?: AgentRunsScope['filter'];
}

/** What's in the page's URL, so a link shows the same list. Anything that doesn't parse is dropped. */
export function validateAgentRunsSearch(s: Record<string, unknown>): AgentRunsSearch {
  const filter = agentRunFilterSchema.safeParse(s.filter);
  return {
    ...(AGENT_RUN_GROUPS.includes(s.group as AgentRunGroup) && {
      group: s.group as AgentRunGroup,
    }),
    ...(typeof s.team === 'string' && { team: s.team }),
    ...(filter.success && Object.keys(filter.data).length > 0 && { filter: filter.data }),
  };
}

/**
 * What agents are doing across the workspace: open runs (queued, working, waiting for an answer,
 * or failed and not yet restarted or dismissed), the ones waiting on something and why, or
 * finished ones.
 */
export function AgentRunsPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const search = useSearch({ from: '/$slug/agent-runs' });
  const scope: AgentRunsScope = {
    filter: search.filter ?? {},
    group: search.group ?? 'open',
    teamId: search.team,
  };
  const setScope = (next: AgentRunsScope) =>
    navigate({
      to: '/$slug/agent-runs',
      params: { slug: ws.slug },
      replace: true,
      search: {
        ...(next.group !== 'open' && { group: next.group }),
        ...(next.teamId && { team: next.teamId }),
        ...(Object.keys(next.filter).length > 0 && { filter: next.filter }),
      },
    });
  const [saveOpen, setSaveOpen] = useState(false);
  const canSave =
    !ws.isGuest && (hasUserFilters(scope.filter) || scope.group !== 'open' || !!scope.teamId);
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
          <div className="flex flex-wrap items-center justify-end gap-2">
            {ws.isAdmin && (
              <button
                type="button"
                className={`btn btn-sm ${paused ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => togglePause.mutate()}
                disabled={togglePause.isPending}
                title={t('agents.runsPage.pauseHint')}
                aria-label={paused ? t('agents.runsPage.resume') : t('agents.runsPage.pause')}
              >
                {paused ? <Play size={12} /> : <Pause size={12} />}
                <span className="hidden sm:inline">
                  {paused ? t('agents.runsPage.resume') : t('agents.runsPage.pause')}
                </span>
              </button>
            )}
            {canSave && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSaveOpen(true)}
              >
                <Save size={13} />
                <span className="hidden sm:inline">{t('issues.view.saveView')}</span>
              </button>
            )}
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
      <AgentRunHoldsPanel scope={scope} onChange={setScope} />
      <AgentRunsControls scope={scope} onChange={setScope} />
      <AgentRunsList scope={scope} onChange={setScope} />
      <SaveViewModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        kind="agentRuns"
        filters={scope.filter}
        display={{ ...DEFAULT_ISSUE_DISPLAY, agentRunGroup: scope.group }}
        teamId={scope.teamId}
      />
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
