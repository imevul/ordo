import type {
  AgentRunHoldChain,
  AgentRunHoldIssue,
  AgentRunHolds,
  AgentRunWaitReason,
} from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { t, tx } from '../i18n/index.ts';
import { shortDate } from '../lib/format.ts';
import { commentAnchor } from '../lib/issues.ts';
import { readPref, writePref } from '../lib/store.ts';
import { cycleName, useWorkspace } from '../lib/workspace.tsx';
import type { AgentRunsScope } from './AgentRunsView.tsx';

const COLLAPSED_PREF = 'agentRunHolds.collapsed';
/** Cycle dates pass, and closing an issue sends no run event. */
const REFRESH_MS = 60_000;

/**
 * Why queued runs aren't starting: each group of them with the one thing it waits for, and the
 * issues someone has to move. Those often have no run at all, so the list below can't show them.
 */
export function AgentRunHoldsPanel({
  scope,
  onChange,
}: {
  scope: AgentRunsScope;
  onChange: (next: AgentRunsScope) => void;
}) {
  const ws = useWorkspace();
  const [collapsed, setCollapsed] = useState(() => readPref(COLLAPSED_PREF, false));
  const { data: holds } = useQuery({
    // Under agentRuns, so run events refetch it too.
    queryKey: ['ws', ws.slug, 'agentRuns', 'holds', scope.teamId ?? null],
    queryFn: () =>
      api.get<AgentRunHolds>(
        wsPath(ws.slug, `/agent-runs/holds${scope.teamId ? `?teamId=${scope.teamId}` : ''}`),
      ),
    refetchInterval: REFRESH_MS,
  });
  if (!holds || (!holds.queued && !holds.needPerson)) return null;
  const showWaitingOn = (reason: AgentRunWaitReason | 'person') =>
    onChange({
      ...scope,
      group: 'waiting',
      filter: { ...scope.filter, agentRunWaitingOn: [reason] },
    });
  const toggle = () => {
    setCollapsed(!collapsed);
    writePref(COLLAPSED_PREF, !collapsed);
  };
  const hasGroups = holds.chains.length > 0 || holds.blocked.length > 0;

  return (
    <section className="flex-none border-b border-border-soft">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
        <h2 className="kicker">{t('agents.holds.title')}</h2>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 font-mono text-[11.5px] text-index">
          <span>{t('agents.holds.working', { count: holds.working })}</span>
          <span>{t('agents.holds.queued', { count: holds.queued })}</span>
          <button
            type="button"
            className="hover:text-highlight"
            onClick={() => showWaitingOn('person')}
          >
            {t('agents.holds.needPerson', { count: holds.needPerson })}
          </button>
          {holds.ready > 0 && (
            <button
              type="button"
              className="text-warning hover:text-highlight"
              onClick={() => showWaitingOn('runner')}
            >
              {t('agents.holds.ready', { count: holds.ready })}
            </button>
          )}
        </span>
        {hasGroups && (
          <button
            type="button"
            className="ml-auto flex items-center gap-1 font-mono text-[10.5px] tracking-[0.1em] text-index uppercase hover:text-text"
            aria-expanded={!collapsed}
            onClick={toggle}
          >
            <ChevronRight size={12} className={collapsed ? '' : 'rotate-90'} />
            {collapsed ? t('agents.holds.show') : t('agents.holds.hide')}
          </button>
        )}
      </div>
      {!collapsed && hasGroups && (
        <div className="max-h-[40vh] overflow-y-auto px-4 pb-2">
          {holds.chains.map((chain) => (
            <ChainGroup key={chain.cycle.id} chain={chain} />
          ))}
          {holds.blocked.map(({ issue, runs }) => (
            <div key={issue.id} className="py-1.5">
              <p className="text-[13px]">
                {tx('agents.holds.blockedBy', {
                  count: runs,
                  issue: <IssueLink issue={issue} />,
                })}
              </p>
              <IssueRow issue={issue} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ChainGroup({ chain }: { chain: AgentRunHoldChain }) {
  const ws = useWorkspace();
  const cycle = (
    <Link
      to="/$slug/team/$key/cycle/$number"
      params={{ slug: ws.slug, key: chain.cycle.teamKey, number: String(chain.cycle.number) }}
      className="text-text hover:text-highlight"
    >
      {cycleName(chain.cycle)}
    </Link>
  );
  const date = chain.date ? shortDate(chain.date) : '';
  let waiting: ReactNode;
  if (chain.waitsFor === 'finish') {
    waiting = tx('agents.holds.waitFinish', { count: chain.total, open: chain.open, cycle });
  } else if (chain.waitsFor === 'start') {
    waiting = tx('agents.holds.waitStart', { cycle, date });
  } else {
    waiting = tx('agents.holds.waitEnd', { cycle, date });
  }
  return (
    <div className="py-1.5">
      <p className="text-[13px] text-muted">
        <span className="font-mono text-[12px] text-text">
          {t('agents.holds.runs', { count: chain.runs })}
        </span>{' '}
        {waiting}
      </p>
      {chain.later.length > 0 && (
        <p className="font-mono text-[11px] text-index">
          {t('agents.holds.later', { cycles: chain.later.map(cycleName).join(' → ') })}
        </p>
      )}
      {chain.working > 0 && (
        <p className="font-mono text-[11px] text-index">
          {t('agents.holds.beingWorkedOn', { count: chain.working })}
        </p>
      )}
      {chain.issues.map((issue) => (
        <IssueRow key={issue.id} issue={issue} />
      ))}
      {chain.nextToStall.length > 0 && (
        <p className="pt-1 font-mono text-[11px] text-index">
          {tx('agents.holds.nextToStall', {
            issues: (
              <>
                {chain.nextToStall.map((issue, i) => (
                  <span key={issue.id}>
                    {i > 0 && ' · '}
                    <IssueLink issue={issue} />
                  </span>
                ))}
              </>
            ),
          })}
        </p>
      )}
    </div>
  );
}

function IssueLink({
  issue,
}: {
  issue: Pick<AgentRunHoldIssue, 'identifier' | 'title' | 'commentId'>;
}) {
  const ws = useWorkspace();
  return (
    <Link
      to="/$slug/issue/$identifier"
      params={{ slug: ws.slug, identifier: issue.identifier }}
      hash={issue.commentId ? commentAnchor(issue.commentId) : undefined}
      className="text-text hover:text-highlight"
      title={issue.title}
    >
      {issue.identifier}
    </Link>
  );
}

/** An issue to act on: who has it, where it stands, and how much waits behind it. */
function IssueRow({ issue }: { issue: AgentRunHoldIssue }) {
  const ws = useWorkspace();
  const assignee = issue.assigneeId ? ws.memberById.get(issue.assigneeId)?.name : undefined;
  const meta = [
    assignee ?? t('agents.holds.unassigned'),
    issue.status,
    ...issue.labels,
    issue.reason === 'needs_person' ? t('agents.holds.needsPerson') : t('agents.holds.noRun'),
    ...(issue.behind > 0 ? [t('agents.holds.behind', { count: issue.behind })] : []),
  ];
  return (
    <div className="mt-1 pl-3">
      <Link
        to="/$slug/issue/$identifier"
        params={{ slug: ws.slug, identifier: issue.identifier }}
        // Waiting for a person: open the comment they have to answer.
        hash={issue.commentId ? commentAnchor(issue.commentId) : undefined}
        className="flex min-w-0 items-baseline gap-2 hover:text-highlight"
      >
        <span className="flex-none font-mono text-[11.5px] text-index">{issue.identifier}</span>
        <span className="min-w-0 text-[13px] sm:truncate">{issue.title}</span>
      </Link>
      <p className="font-mono text-[11px] text-warning">{meta.join(' · ')}</p>
    </div>
  );
}
