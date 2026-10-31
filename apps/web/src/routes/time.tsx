import { formatDuration } from '@ordo/shared';
import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { wsPath } from '../api/client.ts';
import { useTimeReport } from '../api/queries.ts';
import { EmptyState, PageHeader, Sep, Spinner } from '../components/PageHeader.tsx';
import { t } from '../i18n/index.ts';
import { memberChoices, useWorkspace } from '../lib/workspace.tsx';
import { TeamSelect } from './settings/ui.tsx';

const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Logged time by person and project over a range of days, for invoicing; exports to CSV. */
export function TimeReportPage() {
  const ws = useWorkspace();
  const on = ws.workspace.settings.timeTracking;
  const now = new Date();
  const [from, setFrom] = useState(day(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(day(now));
  const [userId, setUserId] = useState('');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [cycleId, setCycleId] = useState('');
  const query = new URLSearchParams(
    Object.entries({ from, to, userId, teamId: teamId ?? '', projectId, cycleId }).filter(
      ([, v]) => v,
    ),
  ).toString();
  const { data: report, isLoading } = useTimeReport(ws.slug, query, on);
  const cycles = ws.cycles
    .filter((c) => !teamId || c.teamId === teamId)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const personName = (id: string | null) =>
    (id && ws.memberById.get(id)?.name) || t('timeTracking.report.formerMember');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('timeTracking.report.kicker')}
          </>
        }
        title={t('timeTracking.report.title')}
        actions={
          on && (
            <a
              className="btn btn-ghost btn-sm"
              href={`/api${wsPath(ws.slug, `/time-entries/report?${query}&format=csv`)}`}
              download
            >
              <Download size={13} /> {t('timeTracking.report.exportCsv')}
            </a>
          )
        }
      />
      {!on ? (
        <EmptyState title={t('timeTracking.report.title')} body={t('timeTracking.report.off')} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-wrap items-end gap-3 border-b border-border-soft px-4 py-3">
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              {t('timeTracking.report.from')}
              <input
                type="date"
                className="input w-40"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              {t('timeTracking.report.to')}
              <input
                type="date"
                className="input w-40"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            {!ws.isGuest && (
              <select
                className="input w-44"
                aria-label={t('timeTracking.report.person')}
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              >
                <option value="">{t('timeTracking.report.anyone')}</option>
                {memberChoices(ws).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
            <TeamSelect
              className="input w-40"
              aria-label={t('common.team')}
              none={t('timeTracking.report.anyTeam')}
              value={teamId}
              onChange={(id) => {
                setTeamId(id);
                setCycleId('');
              }}
            />
            <select
              className="input w-44"
              aria-label={t('common.project')}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">{t('timeTracking.report.anyProject')}</option>
              <option value="none">{t('timeTracking.report.noProject')}</option>
              {ws.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              className="input w-44"
              aria-label={t('common.cycle')}
              value={cycleId}
              onChange={(e) => setCycleId(e.target.value)}
            >
              <option value="">{t('timeTracking.report.anyCycle')}</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {[!teamId && ws.teamById.get(c.teamId)?.key, c.name || `#${c.number}`]
                    .filter(Boolean)
                    .join(' ')}
                </option>
              ))}
            </select>
          </div>

          {isLoading || !report ? (
            <Spinner />
          ) : report.entries.length === 0 ? (
            <EmptyState
              title={t('timeTracking.report.emptyTitle')}
              body={t('timeTracking.report.emptyBody')}
            />
          ) : (
            <>
              <div className="grid gap-6 px-4 py-5 sm:grid-cols-3">
                <div>
                  <div className="section-label mb-2">{t('timeTracking.report.total')}</div>
                  <div className="font-mono text-[22px] text-text">
                    {formatDuration(report.totalSeconds)}
                  </div>
                </div>
                <Totals
                  title={t('timeTracking.report.byPerson')}
                  rows={report.byUser.map((u) => ({
                    key: u.userId ?? 'none',
                    label: personName(u.userId),
                    seconds: u.seconds,
                  }))}
                />
                <Totals
                  title={t('timeTracking.report.byProject')}
                  rows={report.byProject.map((p) => ({
                    key: p.projectId ?? 'none',
                    label:
                      (p.projectId && ws.projectById.get(p.projectId)?.name) ||
                      t('timeTracking.report.noProject'),
                    seconds: p.seconds,
                  }))}
                />
              </div>
              <div className="section-label px-4 pb-2">{t('timeTracking.report.entries')}</div>
              <div className="overflow-x-auto">
                <div className="min-w-[680px]">
                  <div className="grid grid-cols-[6rem_9rem_minmax(0,1fr)_minmax(0,1fr)_5rem] gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
                    <span>{t('timeTracking.report.date')}</span>
                    <span>{t('timeTracking.report.person')}</span>
                    <span>{t('timeTracking.report.issue')}</span>
                    <span>{t('timeTracking.report.note')}</span>
                    <span className="text-right">{t('timeTracking.report.time')}</span>
                  </div>
                  {report.entries.map((e) => (
                    <div
                      key={e.id}
                      className="grid grid-cols-[6rem_9rem_minmax(0,1fr)_minmax(0,1fr)_5rem] items-center gap-3 border-b border-border-soft/60 px-4 py-2 text-[13px]"
                    >
                      <span className="font-mono text-[11.5px] text-muted">{e.date}</span>
                      <span className="truncate text-muted">{personName(e.userId)}</span>
                      <Link
                        to="/$slug/issue/$identifier"
                        params={{ slug: ws.slug, identifier: e.issue.identifier }}
                        className="min-w-0 truncate hover:text-highlight"
                      >
                        <span className="font-mono text-[11.5px] text-index">
                          {e.issue.identifier}
                        </span>{' '}
                        {e.issue.title}
                      </Link>
                      <span className="truncate text-muted">{e.note}</span>
                      <span className="text-right font-mono text-[12.5px]">
                        {formatDuration(e.durationSeconds)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Totals({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; seconds: number }[];
}) {
  return (
    <div>
      <div className="section-label mb-2">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 py-0.5 text-[13px]">
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          <span className="font-mono text-[12px] text-muted">{formatDuration(r.seconds)}</span>
        </div>
      ))}
    </div>
  );
}
