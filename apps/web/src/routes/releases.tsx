import { type Issue, type Release, releaseMarkdown } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Copy, Download, Package, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { ClickToEdit } from '../components/ClickToEdit.tsx';
import { IssuesView } from '../components/IssuesView.tsx';
import { TeamIcon } from '../components/icons.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { MarkdownEditor } from '../components/MarkdownEditor.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { ProgressBar, ProgressStats } from '../components/Progress.tsx';
import { confirmDialog, Modal } from '../components/ui/Modal.tsx';
import { t } from '../i18n/index.ts';
import { shortDate } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

export const releaseKey = (slug: string, id: string) => ['ws', slug, 'release', id] as const;
const suggestionsKey = (slug: string, id: string) =>
  ['ws', slug, 'releaseSuggestions', id] as const;

/** The day a release went out, or the one it's planned for. */
const releaseDate = (r: Release) => r.releasedAt?.slice(0, 10) ?? r.targetDate;

function Scope({ teamId }: { teamId: string | null }) {
  const ws = useWorkspace();
  const team = teamId ? ws.teamById.get(teamId) : null;
  if (!team) return <span className="text-muted">{t('releases.workspaceWide')}</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <TeamIcon color={team.color} label={team.key} size={14} />
      <span className="truncate">{team.name}</span>
    </span>
  );
}

function NewReleaseModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const create = useWsMutation(ws.slug, (body: object) =>
    api.post<Release>(wsPath(ws.slug, '/releases'), body),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name, teamId: teamId || null, targetDate: targetDate || null },
      {
        onSuccess: (r) => {
          onClose();
          navigate({
            to: '/$slug/release/$releaseId',
            params: { slug: ws.slug, releaseId: r.id },
            search: { tab: 'suggested' },
          });
        },
      },
    );
  };
  return (
    <Modal open onClose={onClose} width={520} label={t('releases.newRelease')}>
      <form className="p-5" onSubmit={submit}>
        <div className="section-label mb-4">{t('releases.newRelease')}</div>
        <input
          autoFocus
          className="input"
          placeholder={t('releases.create.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-[12.5px] text-index">
            {t('releases.create.team')}
            <select
              className="input mt-1"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">{t('releases.create.allTeams')}</option>
              {ws.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[12.5px] text-index">
            {t('releases.create.targetDate')}
            <input
              type="date"
              className="input mt-1 font-mono"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            {t('releases.create.submit')} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

const COLS = 'grid-cols-[minmax(0,1fr)_9rem_6rem_4rem_9rem]';

function ReleaseRow({ release }: { release: Release }) {
  const ws = useWorkspace();
  const date = releaseDate(release);
  return (
    <Link
      to="/$slug/release/$releaseId"
      params={{ slug: ws.slug, releaseId: release.id }}
      search={{}}
      className={`row grid h-11 ${COLS} items-center gap-3 border-b border-border-soft/60 px-4`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Package
          size={14}
          className={`flex-none ${release.releasedAt ? 'text-success' : 'text-muted'}`}
        />
        <span className="truncate text-[13.5px]">{release.name}</span>
      </span>
      <span className="min-w-0 text-[12.5px]">
        <Scope teamId={release.teamId} />
      </span>
      <span className="font-mono text-[11.5px] text-muted">{date ? shortDate(date) : '—'}</span>
      <span className="font-mono text-[11.5px] text-muted">{release.progress.total}</span>
      <ProgressBar progress={release.progress} />
    </Link>
  );
}

/** Versions, upcoming first, then those that are out, newest first. */
export function ReleasesPage() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const upcoming = ws.releases.filter((r) => !r.releasedAt);
  const released = ws.releases.filter((r) => r.releasedAt);
  const newButton = (className: string, label: ReactNode) =>
    !ws.isGuest && (
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('releases.title')}
          </>
        }
        title={t('releases.title')}
        actions={newButton(
          'btn btn-primary btn-sm',
          <>
            <Plus size={13} /> {t('releases.newRelease')}
          </>,
        )}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {ws.releases.length === 0 ? (
          <EmptyState
            title={t('releases.list.emptyTitle')}
            body={t('releases.list.emptyBody')}
            action={newButton(
              'btn btn-primary',
              <>
                {t('releases.newRelease')} <span className="arrow">→</span>
              </>,
            )}
          />
        ) : (
          <div className="min-w-[640px]">
            <div
              className={`grid ${COLS} items-center gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase`}
            >
              <span>{t('releases.list.columns.name')}</span>
              <span>{t('releases.list.columns.scope')}</span>
              <span>{t('releases.list.columns.date')}</span>
              <span>{t('releases.list.columns.issues')}</span>
              <span>{t('releases.list.columns.progress')}</span>
            </div>
            {(
              [
                ['upcoming', upcoming],
                ['released', released],
              ] as const
            ).map(([id, list]) =>
              list.length ? (
                <section key={id}>
                  <div className="section-label px-4 pt-5 pb-2">{t(`releases.list.${id}`)}</div>
                  {list.map((r) => (
                    <ReleaseRow key={r.id} release={r} />
                  ))}
                </section>
              ) : null,
            )}
          </div>
        )}
      </div>
      {open && <NewReleaseModal onClose={() => setOpen(false)} />}
    </div>
  );
}

function useRelease(slug: string, id: string) {
  return useQuery({
    queryKey: releaseKey(slug, id),
    queryFn: () => api.get<Release>(wsPath(slug, `/releases/${id}`)),
  });
}

export function ReleasePage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { releaseId } = useParams({ from: '/$slug/release/$releaseId' });
  const { tab } = useSearch({ from: '/$slug/release/$releaseId' });
  const listed = ws.releases.find((r) => r.id === releaseId);
  const { data: full } = useRelease(ws.slug, releaseId);
  const invalidate = [releaseKey(ws.slug, releaseId), suggestionsKey(ws.slug, releaseId)];
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/releases/${releaseId}`)));
  const release = useWsMutation(
    ws.slug,
    () => api.post<Release>(wsPath(ws.slug, `/releases/${releaseId}/release`)),
    { invalidate },
  );
  const reopen = useWsMutation(
    ws.slug,
    () => api.post<Release>(wsPath(ws.slug, `/releases/${releaseId}/reopen`)),
    { invalidate },
  );
  if (!listed) return <EmptyState title={t('releases.detail.notFound')} />;
  const r = { ...listed, notes: full?.notes };
  const out = !!r.releasedAt;
  const readOnly = ws.isGuest;
  const date = releaseDate(r);

  const markdown = () => releaseMarkdown({ ...r, notes: r.notes ?? '' });
  const tabs = (
    <div className="flex gap-1 px-4 pb-2">
      {(['notes', 'issues', 'suggested'] as const)
        .filter((name) => name !== 'suggested' || (!out && !readOnly))
        .map((name) => (
          <Link
            key={name}
            to="/$slug/release/$releaseId"
            params={{ slug: ws.slug, releaseId }}
            search={name === 'notes' ? {} : { tab: name }}
            className={`h-6 px-2.5 font-mono text-[11px] leading-6 tracking-[0.1em] uppercase ${(tab ?? 'notes') === name ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
          >
            {t(`releases.detail.tabs.${name}`)}
          </Link>
        ))}
    </div>
  );
  const actions = (
    <>
      <a
        className="btn btn-ghost btn-sm"
        href={`/api${wsPath(ws.slug, `/releases/${releaseId}/notes.md`)}`}
        download
        aria-label={t('releases.detail.download')}
        title={t('releases.detail.download')}
      >
        <Download size={13} />
      </a>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-label={t('releases.detail.copy')}
        title={t('releases.detail.copy')}
        disabled={r.notes === undefined}
        onClick={() => {
          navigator.clipboard?.writeText(markdown());
          toast.success(t('releases.detail.copied'));
        }}
      >
        <Copy size={13} />
      </button>
      {!readOnly && (
        <>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            aria-label={t('releases.detail.delete')}
            title={t('releases.detail.delete')}
            onClick={async () => {
              if (
                await confirmDialog({
                  title: t('releases.detail.confirmDeleteTitle', { name: r.name }),
                  body: t('releases.detail.confirmDeleteBody'),
                  confirmLabel: t('releases.detail.delete'),
                  danger: true,
                })
              )
                remove.mutate(undefined, {
                  onSuccess: () => navigate({ to: '/$slug/releases', params: { slug: ws.slug } }),
                });
            }}
          >
            <Trash2 size={13} />
          </button>
          {out ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={reopen.isPending}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: t('releases.detail.reopenTitle', { name: r.name }),
                    body: t('releases.detail.reopenBody'),
                    confirmLabel: t('releases.detail.reopen'),
                  })
                )
                  reopen.mutate(undefined);
              }}
            >
              {t('releases.detail.reopen')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={release.isPending}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: t('releases.detail.releaseTitle', { name: r.name }),
                    body: t('releases.detail.releaseBody'),
                    confirmLabel: t('releases.detail.release'),
                  })
                )
                  release.mutate(undefined, {
                    onSuccess: () => {
                      toast.success(t('releases.detail.released', { name: r.name }));
                      if (tab)
                        navigate({
                          to: '/$slug/release/$releaseId',
                          params: { slug: ws.slug, releaseId },
                          search: {},
                        });
                    },
                  });
              }}
            >
              {t('releases.detail.release')} <span className="arrow">→</span>
            </button>
          )}
        </>
      )}
    </>
  );
  const kicker = (
    <>
      <Link to="/$slug/releases" params={{ slug: ws.slug }} className="hover:text-highlight">
        {t('releases.title')}
      </Link>
      <Sep />
      {out
        ? t('releases.detail.releasedOn', { date: shortDate(date!) })
        : t('releases.detail.planned')}
    </>
  );

  if (tab === 'issues')
    return (
      <IssuesView
        key={r.id}
        kicker={kicker}
        title={r.name}
        baseFilter={{ releaseIds: [r.id], archived: 'include' }}
        teamId={r.teamId ?? undefined}
        storageKey="release"
        createDefaults={
          out ? undefined : { releaseId: r.id, ...(r.teamId && { teamId: r.teamId }) }
        }
        tabs={tabs}
        actions={actions}
      />
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader kicker={kicker} title={r.name} actions={actions}>
        {tabs}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'suggested' && !out && !readOnly ? (
          <Suggestions release={r} />
        ) : (
          <NotesTab release={r} readOnly={readOnly} />
        )}
      </div>
    </div>
  );
}

function NotesTab({ release: r, readOnly }: { release: Release; readOnly: boolean }) {
  const ws = useWorkspace();
  const invalidate = [releaseKey(ws.slug, r.id)];
  const save = useWsMutation(
    ws.slug,
    (body: object) => api.patch<Release>(wsPath(ws.slug, `/releases/${r.id}`), body),
    { invalidate },
  );
  const [name, setName] = useState(r.name);
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(r.notes ?? '');
  const [drafting, setDrafting] = useState(false);
  useEffect(() => setName(r.name), [r.name]);
  useEffect(() => {
    if (!editing) setNotes(r.notes ?? '');
  }, [r.notes, editing]);
  const out = !!r.releasedAt;

  const draft = async () => {
    if (
      notes.trim() &&
      !(await confirmDialog({
        title: t('releases.detail.draftReplaceTitle'),
        body: t('releases.detail.draftReplaceBody'),
        confirmLabel: t('releases.detail.draftReplace'),
      }))
    )
      return;
    setDrafting(true);
    try {
      const res = await api.post<{ notes: string }>(wsPath(ws.slug, `/releases/${r.id}/draft`));
      setNotes(res.notes);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDrafting(false);
    }
  };
  const submit = () => {
    save.mutate({ notes });
    setEditing(false);
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-10 px-6 py-8 lg:grid-cols-[1fr_16rem]">
      <div className="min-w-0">
        <input
          value={name}
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== r.name && save.mutate({ name })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="w-full bg-transparent text-[28px] font-bold tracking-[-0.02em] outline-none"
          aria-label={t('releases.detail.nameLabel')}
        />
        <div className="mt-6">
          <div className="section-label mb-3">{t('releases.detail.progress')}</div>
          <ProgressStats progress={r.progress} />
          <ProgressBar progress={r.progress} className="mt-3" />
        </div>
        <div className="section-label mt-8 mb-3">{t('releases.detail.notes')}</div>
        <ClickToEdit
          editing={editing}
          onEdit={() => setEditing(true)}
          disabled={readOnly || r.notes === undefined}
          className="min-h-10"
          editor={
            <>
              <MarkdownEditor
                value={notes}
                onChange={setNotes}
                autoFocus
                minRows={8}
                onSubmit={submit}
                onCancel={() => setEditing(false)}
              />
              <div className="mt-2 flex flex-wrap justify-between gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={drafting}
                  onClick={draft}
                >
                  {t('releases.detail.draft')}
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setEditing(false)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={submit}>
                    {t('common.save')}
                  </button>
                </div>
              </div>
            </>
          }
        >
          {r.notes?.trim() ? (
            <Markdown source={r.notes} />
          ) : (
            <p className="text-index">
              {out
                ? t('releases.detail.notesPlaceholderOut')
                : t('releases.detail.notesPlaceholder')}
            </p>
          )}
        </ClickToEdit>
      </div>

      <aside>
        <div className="section-label mb-3">{t('releases.detail.properties')}</div>
        <div className="flex flex-col gap-3 text-[12.5px]">
          <div className="text-index">
            {t('releases.detail.status')}
            <div className={`mt-1 ${out ? 'text-success' : 'text-text'}`}>
              {out
                ? t('releases.detail.statusReleased', { date: shortDate(r.releasedAt!) })
                : t('releases.detail.statusPlanned')}
            </div>
          </div>
          <div className="text-index">
            {t('releases.create.team')}
            <div className="mt-1 text-text">
              <Scope teamId={r.teamId} />
            </div>
          </div>
          <label className="block text-index">
            {t('releases.detail.targetDate')}
            <input
              type="date"
              disabled={readOnly}
              className="input mt-1 h-8 font-mono"
              value={r.targetDate ?? ''}
              onChange={(e) => save.mutate({ targetDate: e.target.value || null })}
            />
          </label>
          {out && <p className="text-[12px] text-index">{t('releases.detail.frozen')}</p>}
        </div>
      </aside>
    </div>
  );
}

/** Done issues the release could take, all picked to start with. */
function Suggestions({ release: r }: { release: Release }) {
  const ws = useWorkspace();
  const { data: list } = useQuery({
    queryKey: suggestionsKey(ws.slug, r.id),
    queryFn: () => api.get<Issue[]>(wsPath(ws.slug, `/releases/${r.id}/suggestions`)),
  });
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  // One request for all of them: a first release can suggest more than a batch edit takes.
  const add = useWsMutation(
    ws.slug,
    (ids: string[]) =>
      api.post<{ ids: string[] }>(wsPath(ws.slug, `/releases/${r.id}/issues`), { ids }),
    {
      invalidate: [
        suggestionsKey(ws.slug, r.id),
        releaseKey(ws.slug, r.id),
        ['ws', ws.slug, 'issues'],
      ],
    },
  );
  if (!list) return null;
  const picked = list.filter((i) => !skipped.has(i.id));
  const toggle = (id: string) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
      <p className="mb-4 text-[13px] text-muted">{t('releases.suggested.intro')}</p>
      {list.length === 0 ? (
        <p className="font-mono text-[12px] text-index">{t('releases.suggested.empty')}</p>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[12.5px] text-muted">
              <input
                type="checkbox"
                className="accent-primary"
                checked={skipped.size === 0}
                onChange={() =>
                  setSkipped(skipped.size === 0 ? new Set(list.map((i) => i.id)) : new Set())
                }
              />
              {t('releases.suggested.selectAll')}
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={picked.length === 0 || add.isPending}
              onClick={() =>
                add.mutate(
                  picked.map((i) => i.id),
                  {
                    onSuccess: () => {
                      toast.success(t('releases.suggested.added', { count: picked.length }));
                      setSkipped(new Set());
                    },
                  },
                )
              }
            >
              {t('releases.suggested.add', { count: picked.length })}
            </button>
          </div>
          {list.map((i) => {
            const labels = i.labelIds.map((l) => ws.labelById.get(l)).filter((l) => !!l);
            return (
              <label
                key={i.id}
                className="row flex h-10 cursor-pointer items-center gap-3 border-b border-border-soft/60 px-1"
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={!skipped.has(i.id)}
                  onChange={() => toggle(i.id)}
                />
                <span className="w-16 flex-none font-mono text-[11.5px] text-index">
                  {i.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{i.title}</span>
                <span className="hidden gap-1 sm:flex">
                  {labels.map((l) => (
                    <span key={l.id} className="tag">
                      <span className="tag-dot" style={{ background: l.color }} />
                      {l.name}
                    </span>
                  ))}
                </span>
                {i.completedAt && (
                  <span className="hidden flex-none font-mono text-[11px] text-index md:inline">
                    {t('releases.suggested.completed', { date: shortDate(i.completedAt) })}
                  </span>
                )}
              </label>
            );
          })}
        </>
      )}
    </div>
  );
}
