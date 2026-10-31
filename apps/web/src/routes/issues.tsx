import type { Issue, IssueFilter } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { RotateCcw, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import {
  invalidateIssues,
  useIssue,
  useIssues,
  useRestoreIssues,
  useSearch,
} from '../api/queries.ts';
import { IssueDetailView } from '../components/IssueDetailView.tsx';
import { IssuesView } from '../components/IssuesView.tsx';
import { StatusIcon, TeamIcon } from '../components/icons.tsx';
import { EmptyState, PageHeader, Sep, Spinner } from '../components/PageHeader.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { confirmDialog } from '../components/ui/Modal.tsx';
import { t } from '../i18n/index.ts';
import { relativeTime, shortDate } from '../lib/format.ts';
import { newerIdentifier } from '../lib/issues.ts';
import { useWorkspace } from '../lib/workspace.tsx';

function Tabs({
  tabs,
}: {
  tabs: { to: string; params: Record<string, string>; label: string; active: boolean }[];
}) {
  return (
    <div className="flex gap-1 px-4 pb-2">
      {tabs.map((tab) => (
        <Link
          key={tab.to + JSON.stringify(tab.params)}
          to={tab.to}
          params={tab.params as never}
          className={`h-6 px-2.5 font-mono text-[11px] leading-6 tracking-[0.1em] uppercase transition-colors ${tab.active ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

export function MyIssuesPage() {
  const ws = useWorkspace();
  const { tab } = useParams({ from: '/$slug/my-issues/$tab' });
  const filter = useMemo<IssueFilter>(
    () =>
      tab === 'created'
        ? { creatorIds: ['me'] }
        : tab === 'subscribed'
          ? { subscribedBy: 'me' }
          : { assigneeIds: ['me'] },
    [tab],
  );
  const tabs = (['assigned', 'created', 'subscribed'] as const).map((name) => ({
    to: '/$slug/my-issues/$tab',
    params: { slug: ws.slug, tab: name },
    label: t(`issues.myIssues.${name}`),
    active: name === tab,
  }));
  return (
    <IssuesView
      key={tab}
      kicker={
        <>
          {ws.workspace.name}
          <Sep />
          {t('issues.myIssues.title')}
        </>
      }
      title={t('issues.myIssues.title')}
      baseFilter={filter}
      storageKey={`my:${tab}`}
      defaultDisplay={{ groupBy: 'state', showCompleted: false }}
      createDefaults={tab === 'assigned' ? { assigneeId: ws.me.id } : {}}
      tabs={<Tabs tabs={tabs} />}
      emptyTitle={tab === 'assigned' ? t('issues.myIssues.inboxZero') : t('issues.view.emptyTitle')}
      emptyBody={tab === 'assigned' ? t('issues.myIssues.nothingAssigned') : undefined}
    />
  );
}

export function TeamIssuesPage() {
  const ws = useWorkspace();
  const { key, tab } = useParams({ from: '/$slug/team/$key/$tab' });
  const team = ws.teamByKey.get(key);
  const filter = useMemo<IssueFilter>(() => {
    if (!team) return {};
    if (tab === 'active') return { teamId: team.id, stateTypes: ['unstarted', 'started'] };
    if (tab === 'backlog') return { teamId: team.id, stateTypes: ['backlog'] };
    if (tab === 'triage') return { teamId: team.id, stateTypes: ['triage'] };
    if (tab === 'archived') return { teamId: team.id, archived: 'only' };
    return { teamId: team.id };
  }, [team, tab]);
  if (!team) return <EmptyState title={t('issues.team.notFound')} />;
  const teamTabs = ['triage', 'all', 'active', 'backlog', 'archived'] as const;
  const isTeamTab = (v: string): v is (typeof teamTabs)[number] =>
    (teamTabs as readonly string[]).includes(v);
  const tabs = teamTabs
    .filter((name) => name !== 'triage' || team.triageEnabled)
    .map((name) => ({
      to: '/$slug/team/$key/$tab',
      params: { slug: ws.slug, key, tab: name },
      label: t(`issues.team.${name}`),
      active: name === tab,
    }));
  const triage = team.states.find((s) => s.type === 'triage');
  return (
    <IssuesView
      key={`${team.id}:${tab}`}
      kicker={
        <span className="inline-flex items-center gap-1.5">
          <TeamIcon color={team.color} label={team.key} size={12} />
          {team.key}
          <Sep />
          {isTeamTab(tab) ? t(`issues.team.${tab}`) : tab}
        </span>
      }
      title={team.name}
      baseFilter={filter}
      teamId={team.id}
      storageKey={`team:${team.id}:${tab}`}
      defaultDisplay={
        tab === 'backlog' || tab === 'triage'
          ? { groupBy: 'none', orderBy: 'createdAt' }
          : tab === 'archived'
            ? { groupBy: 'none', orderBy: 'updatedAt', showCompleted: true }
            : {}
      }
      createDefaults={{
        teamId: team.id,
        ...(tab === 'triage' && triage ? { stateId: triage.id } : {}),
      }}
      tabs={<Tabs tabs={tabs} />}
      emptyTitle={
        tab === 'triage'
          ? t('issues.team.triageClear')
          : tab === 'archived'
            ? t('issues.team.nothingArchived')
            : undefined
      }
    />
  );
}

export function IssuePage() {
  const ws = useWorkspace();
  const { identifier } = useParams({ from: '/$slug/issue/$identifier' });
  const { data, error, isLoading } = useIssue(ws.slug, identifier);
  const navigate = useNavigate();
  // A move sent later (queued offline or by another tab) renumbers the issue under this page,
  // and old links resolve to the moved issue: keep the URL (and so copied links) current.
  const newer = data ? newerIdentifier(identifier, data) : null;
  useEffect(() => {
    if (newer)
      navigate({
        to: '/$slug/issue/$identifier',
        params: { slug: ws.slug, identifier: newer },
        replace: true,
      });
  }, [newer, navigate, ws.slug]);
  if (isLoading) return <Spinner label={t('issues.issuePage.loading', { id: identifier })} />;
  if (error || !data)
    return (
      <EmptyState
        title={t('issues.issuePage.notFound')}
        body={t('issues.issuePage.notFoundBody', { id: identifier })}
      />
    );
  return <IssueDetailView key={data.id} issue={data} />;
}

function PlainIssueRow({ issue, right }: { issue: Issue; right?: React.ReactNode }) {
  const ws = useWorkspace();
  const s = ws.stateById.get(issue.stateId);
  const a = issue.assigneeId ? ws.memberById.get(issue.assigneeId) : null;
  return (
    <div className="row flex h-10 items-center gap-2.5 border-b border-border-soft/60 px-4">
      {s && <StatusIcon type={s.type} color={s.color} />}
      <span className="w-[4.75rem] flex-none font-mono text-[11.5px] text-index">
        {issue.identifier}
      </span>
      <Link
        to="/$slug/issue/$identifier"
        params={{ slug: ws.slug, identifier: issue.identifier }}
        className="min-w-0 flex-1 truncate text-[13.5px]"
      >
        {issue.title}
      </Link>
      {issue.archivedAt && <span className="tag font-mono">{t('issues.searchPage.archived')}</span>}
      <span className="hidden font-mono text-[11px] text-index sm:block">
        {shortDate(issue.updatedAt)}
      </span>
      {a && <Avatar name={a.name} color={a.avatarColor} src={a.avatarUrl} />}
      {right}
    </div>
  );
}

export function SearchPage() {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const { data, isFetching } = useSearch(ws.slug, q);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('issues.searchPage.title')}
          </>
        }
        title={t('issues.searchPage.title')}
      >
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 border border-border bg-bg px-3 focus-within:border-primary">
            <Search size={15} className="text-index" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('issues.searchPage.placeholder')}
              className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-index"
            />
            {isFetching && <span className="cursor-blink" aria-hidden />}
          </div>
        </div>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data?.projects.length ? (
          <div className="border-b border-border-soft px-4 py-3">
            <div className="section-label mb-2">{t('common.projects')}</div>
            <div className="flex flex-wrap gap-2">
              {data.projects.map((p) => (
                <Link
                  key={p.id}
                  to="/$slug/project/$projectId"
                  params={{ slug: ws.slug, projectId: p.id }}
                  className="tag hover:text-text"
                >
                  <span className="tag-dot" style={{ background: p.color }} />
                  {p.name}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        {data?.issues.map((i) => (
          <PlainIssueRow key={i.id} issue={i} />
        ))}
        {q && data && data.issues.length === 0 && data.projects.length === 0 && (
          <EmptyState
            title={t('issues.searchPage.noMatches')}
            body={t('issues.searchPage.nothingMatches', { query: q })}
          />
        )}
        {!q && (
          <EmptyState
            title={t('issues.searchPage.emptyTitle')}
            body={t('issues.searchPage.emptyBody')}
          />
        )}
      </div>
    </div>
  );
}

export function TrashPage() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const { data, isLoading } = useIssues(ws.slug, { trashed: true });
  const restoreIssues = useRestoreIssues(ws.slug);
  const restore = (issue: Issue) =>
    restoreIssues.mutate([issue.id], {
      onSuccess: () => toast.success(t('issues.trash.restored', { id: issue.identifier })),
    });
  const purge = async (issue: Issue) => {
    if (
      !(await confirmDialog({
        title: t('issues.trash.confirmTitle', { id: issue.identifier }),
        body: t('issues.trash.confirmBody'),
        confirmLabel: t('issues.trash.deleteForever'),
        danger: true,
      }))
    )
      return;
    await api.del(wsPath(ws.slug, `/issues/${issue.id}/purge`));
    invalidateIssues(qc, ws.slug);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('issues.trash.title')}
          </>
        }
        title={t('issues.trash.title')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <Spinner />}
        {data?.length === 0 && (
          <EmptyState title={t('issues.trash.emptyTitle')} body={t('issues.trash.emptyBody')} />
        )}
        {data?.map((i) => (
          <PlainIssueRow
            key={i.id}
            issue={i}
            right={
              <span className="flex items-center gap-1">
                <span className="mr-2 hidden font-mono text-[11px] text-index md:block">
                  {i.deletedAt && t('issues.trash.deleted', { time: relativeTime(i.deletedAt) })}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => restore(i)}>
                  <RotateCcw size={12} /> {t('common.restore')}
                </button>
                {ws.isAdmin && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => purge(i)}
                    aria-label={t('issues.trash.deleteForever')}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </span>
            }
          />
        ))}
      </div>
    </div>
  );
}
