import { type Cycle, isCycleCurrent } from '@ordo/shared';
import { Link, useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { IssuesView } from '../components/IssuesView.tsx';
import { TeamIcon } from '../components/icons.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { ProgressBar, ProgressStats } from '../components/Progress.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { t } from '../i18n/index.ts';
import { addDays, shortDate, today } from '../lib/format.ts';
import { cycleName, useWorkspace } from '../lib/workspace.tsx';

function CycleModal({
  open,
  onClose,
  teamId,
  cycle,
}: {
  open: boolean;
  onClose: () => void;
  teamId: string;
  cycle?: Cycle;
}) {
  const ws = useWorkspace();
  const last = ws.cycles.filter((c) => c.teamId === teamId).at(-1);
  const defaultStart = last && last.endsAt > today() ? last.endsAt : today();
  const [name, setName] = useState(cycle?.name ?? '');
  const [startsAt, setStartsAt] = useState(cycle?.startsAt ?? defaultStart);
  const [endsAt, setEndsAt] = useState(cycle?.endsAt ?? addDays(defaultStart, 14));
  const save = useWsMutation(
    ws.slug,
    (body: object) =>
      cycle
        ? api.patch(wsPath(ws.slug, `/cycles/${cycle.id}`), body)
        : api.post(wsPath(ws.slug, `/teams/${teamId}/cycles`), body),
    { success: cycle ? t('cycles.modal.updated') : t('cycles.modal.created') },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: name || null, startsAt, endsAt }, { onSuccess: onClose });
  };
  return (
    <Modal open={open} onClose={onClose} width={440} label={t('common.cycle')} align="center">
      <form onSubmit={submit} className="p-6">
        <div className="section-label mb-4">
          {cycle
            ? t('cycles.modal.editTitle', { name: cycleName(cycle) })
            : t('cycles.modal.newTitle')}
        </div>
        <label className="block text-[12px] text-muted">
          {t('cycles.modal.name')}
          <input
            className="input mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('common.cycleNumber', { number: (last?.number ?? 0) + 1 })}
          />
        </label>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block text-[12px] text-muted">
            {t('cycles.modal.starts')}
            <input
              type="date"
              className="input mt-1"
              required
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </label>
          <label className="block text-[12px] text-muted">
            {t('cycles.modal.ends')}
            <input
              type="date"
              className="input mt-1"
              required
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={save.isPending}>
            {cycle ? t('common.save') : t('cycles.modal.create')} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CycleRow({ cycle, teamKey, badge }: { cycle: Cycle; teamKey: string; badge?: string }) {
  const ws = useWorkspace();
  return (
    <Link
      to="/$slug/team/$key/cycle/$number"
      params={{ slug: ws.slug, key: teamKey, number: String(cycle.number) }}
      className="panel panel-sm panel-interactive mb-2 grid grid-cols-[1fr_auto] items-center gap-4 p-4 md:grid-cols-[1fr_12rem_14rem]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{cycleName(cycle)}</span>
          {badge && <span className="chip [--chip:var(--color-success)]">{badge}</span>}
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-index">
          {shortDate(cycle.startsAt)} → {shortDate(cycle.endsAt)}
        </div>
      </div>
      <div className="hidden font-mono text-[11.5px] text-muted md:block">
        {t('cycles.issueProgress', {
          completed: cycle.progress.completed,
          count: cycle.progress.total,
        })}
        {cycle.progress.totalEstimate > 0 && (
          <span className="text-index">
            {' '}
            ·{' '}
            {t('cycles.pointProgress', {
              completed: cycle.progress.completedEstimate,
              count: cycle.progress.totalEstimate,
            })}
          </span>
        )}
      </div>
      <ProgressBar progress={cycle.progress} className="w-28 md:w-auto" />
    </Link>
  );
}

export function CyclesPage() {
  const ws = useWorkspace();
  const { key } = useParams({ from: '/$slug/team/$key/cycles' });
  const team = ws.teamByKey.get(key);
  const [open, setOpen] = useState(false);
  if (!team) return <EmptyState title={t('cycles.teamNotFound')} />;
  const now = today();
  const cycles = ws.cycles.filter((c) => c.teamId === team.id);
  const current = cycles.filter((c) => isCycleCurrent(c, now));
  const upcoming = cycles.filter((c) => c.startsAt > now);
  const past = cycles.filter((c) => c.endsAt <= now).reverse();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <TeamIcon color={team.color} label={team.key} size={12} />
            {team.key}
            <Sep />
            {t('cycles.kicker')}
          </span>
        }
        title={t('common.cycles')}
        actions={
          !ws.isGuest && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
              <Plus size={13} /> {t('cycles.newCycle')}
            </button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        {cycles.length === 0 ? (
          <EmptyState
            title={t('cycles.empty.title')}
            body={t('cycles.empty.body')}
            action={
              !ws.isGuest && (
                <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
                  {t('cycles.empty.action')} <span className="arrow">→</span>
                </button>
              )
            }
          />
        ) : (
          <div className="mx-auto max-w-4xl">
            {(
              [
                ['current', t('cycles.current'), current, t('cycles.active')],
                ['upcoming', t('cycles.upcoming'), upcoming, undefined],
                ['past', t('cycles.past'), past, undefined],
              ] as const
            ).map(([id, label, list, badge]) =>
              list.length ? (
                <section key={id} className="mb-8">
                  <div className="section-label mb-3">{label}</div>
                  {list.map((c) => (
                    <CycleRow key={c.id} cycle={c} teamKey={team.key} badge={badge} />
                  ))}
                </section>
              ) : null,
            )}
          </div>
        )}
      </div>
      {open && <CycleModal open onClose={() => setOpen(false)} teamId={team.id} />}
    </div>
  );
}

export function CycleDetailPage() {
  const ws = useWorkspace();
  const { key, number } = useParams({ from: '/$slug/team/$key/cycle/$number' });
  const team = ws.teamByKey.get(key);
  const cycle = ws.cycles.find((c) => c.teamId === team?.id && c.number === Number(number));
  const [edit, setEdit] = useState(false);
  if (!team || !cycle) return <EmptyState title={t('cycles.cycleNotFound')} />;
  return (
    <>
      <IssuesView
        key={cycle.id}
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <TeamIcon color={team.color} label={team.key} size={12} />
            {team.key}
            <Sep />
            {shortDate(cycle.startsAt)} → {shortDate(cycle.endsAt)}
          </span>
        }
        title={cycleName(cycle)}
        baseFilter={{ teamId: team.id, cycleIds: [cycle.id] }}
        teamId={team.id}
        storageKey={`cycle:${team.id}`}
        defaultDisplay={{ layout: 'board' }}
        createDefaults={{ teamId: team.id, cycleId: cycle.id }}
        burn={{ from: cycle.startsAt, to: cycle.endsAt }}
        insightsOpen
        actions={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(true)}>
            {t('common.edit')}
          </button>
        }
        tabs={
          <div className="px-4 pb-3">
            <ProgressStats progress={cycle.progress} />
          </div>
        }
      />
      {edit && <CycleModal open onClose={() => setEdit(false)} teamId={team.id} cycle={cycle} />}
    </>
  );
}
