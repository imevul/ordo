import {
  INITIATIVE_STATUSES,
  type Initiative,
  type InitiativeStatus,
  LABEL_COLORS,
} from '@ordo/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Goal, Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { ClickToEdit } from '../components/ClickToEdit.tsx';
import { ProjectIcon, ProjectStatusIcon } from '../components/icons.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { MarkdownEditor } from '../components/MarkdownEditor.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { ProgressBar, ProgressStats } from '../components/Progress.tsx';
import { assigneeOptions, Picker } from '../components/properties.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { confirmDialog, Modal } from '../components/ui/Modal.tsx';
import { t } from '../i18n/index.ts';
import { initiativeStatusLabel, projectStatusLabel } from '../i18n/labels.ts';
import { shortDate } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

const STATUS_COLOR: Record<InitiativeStatus, string> = {
  planned: 'var(--color-muted)',
  active: 'var(--color-warning)',
  completed: 'var(--color-success)',
};

export function InitiativeIcon({ color, size = 14 }: { color: string; size?: number }) {
  return <Goal size={size} style={{ color }} className="flex-none" />;
}

function StatusChip({ status }: { status: InitiativeStatus }) {
  return (
    <span className="chip" style={{ '--chip': STATUS_COLOR[status] } as React.CSSProperties}>
      {initiativeStatusLabel(status)}
    </span>
  );
}

function NewInitiativeModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const create = useWsMutation(ws.slug, (body: object) =>
    api.post<Initiative>(wsPath(ws.slug, '/initiatives'), body),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name, targetDate: targetDate || null, ownerId: ws.me.id },
      {
        onSuccess: (i) => {
          onClose();
          navigate({
            to: '/$slug/initiative/$initiativeId',
            params: { slug: ws.slug, initiativeId: i.id },
          });
        },
      },
    );
  };
  return (
    <Modal open onClose={onClose} width={520} label={t('initiatives.newInitiative')}>
      <form className="p-5" onSubmit={submit}>
        <div className="section-label mb-4">{t('initiatives.newInitiative')}</div>
        <input
          autoFocus
          className="input"
          placeholder={t('initiatives.create.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="mt-3 block text-[12.5px] text-index">
          {t('initiatives.create.targetDate')}
          <input
            type="date"
            className="input mt-1 font-mono"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            {t('initiatives.create.submit')} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Workspace goals, each grouping projects, with their summed progress. */
export function InitiativesPage() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const order = (i: Initiative) => INITIATIVE_STATUSES.indexOf(i.status);
  const list = [...ws.initiatives].sort(
    (a, b) =>
      (a.status === 'completed' ? 1 : 0) - (b.status === 'completed' ? 1 : 0) ||
      order(b) - order(a) ||
      a.sortOrder - b.sortOrder,
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('initiatives.title')}
          </>
        }
        title={t('initiatives.title')}
        actions={
          !ws.isGuest && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
              <Plus size={13} /> {t('initiatives.newInitiative')}
            </button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <EmptyState
            title={t('initiatives.list.emptyTitle')}
            body={t('initiatives.list.emptyBody')}
            action={
              !ws.isGuest && (
                <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
                  {t('initiatives.newInitiative')} <span className="arrow">→</span>
                </button>
              )
            }
          />
        ) : (
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[minmax(0,1fr)_7rem_8rem_6rem_6rem_9rem] items-center gap-3 border-b border-border-soft px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              <span>{t('initiatives.list.columns.name')}</span>
              <span>{t('initiatives.list.columns.status')}</span>
              <span>{t('initiatives.list.columns.owner')}</span>
              <span>{t('initiatives.list.columns.projects')}</span>
              <span>{t('initiatives.list.columns.target')}</span>
              <span>{t('initiatives.list.columns.progress')}</span>
            </div>
            {list.map((i) => {
              const owner = i.ownerId ? ws.memberById.get(i.ownerId) : null;
              return (
                <Link
                  key={i.id}
                  to="/$slug/initiative/$initiativeId"
                  params={{ slug: ws.slug, initiativeId: i.id }}
                  className="row grid h-11 grid-cols-[minmax(0,1fr)_7rem_8rem_6rem_6rem_9rem] items-center gap-3 border-b border-border-soft/60 px-4"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <InitiativeIcon color={i.color} />
                    <span className="truncate text-[13.5px]">{i.name}</span>
                  </span>
                  <StatusChip status={i.status} />
                  <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
                    {owner && (
                      <Avatar
                        name={owner.name}
                        color={owner.avatarColor}
                        src={owner.avatarUrl}
                        size={16}
                      />
                    )}
                    <span className="truncate">{owner?.name.split(' ')[0] ?? '—'}</span>
                  </span>
                  <span className="font-mono text-[11.5px] text-muted">{i.projectIds.length}</span>
                  <span className="font-mono text-[11.5px] text-muted">
                    {i.targetDate ? shortDate(i.targetDate) : '—'}
                  </span>
                  <ProgressBar progress={i.progress} />
                </Link>
              );
            })}
          </div>
        )}
      </div>
      {open && <NewInitiativeModal onClose={() => setOpen(false)} />}
    </div>
  );
}

export function InitiativePage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { initiativeId } = useParams({ from: '/$slug/initiative/$initiativeId' });
  const initiative = ws.initiatives.find((i) => i.id === initiativeId);
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/initiatives/${initiativeId}`), body),
  );
  const remove = useWsMutation(ws.slug, () =>
    api.del(wsPath(ws.slug, `/initiatives/${initiativeId}`)),
  );
  const moveProject = useWsMutation(ws.slug, (v: { id: string; initiativeId: string | null }) =>
    api.patch(wsPath(ws.slug, `/projects/${v.id}`), { initiativeId: v.initiativeId }),
  );
  const [name, setName] = useState(initiative?.name ?? '');
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState(initiative?.description ?? '');
  useEffect(() => setName(initiative?.name ?? ''), [initiative?.name]);
  if (!initiative) return <EmptyState title={t('initiatives.detail.notFound')} />;

  const readOnly = ws.isGuest;
  const projects = initiative.projectIds.map((id) => ws.projectById.get(id)).filter((p) => !!p);
  const others = ws.projects.filter((p) => p.initiativeId !== initiative.id);
  const owner = initiative.ownerId ? ws.memberById.get(initiative.ownerId) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            <Link
              to="/$slug/initiatives"
              params={{ slug: ws.slug }}
              className="hover:text-highlight"
            >
              {t('initiatives.title')}
            </Link>
            <Sep />
            {initiativeStatusLabel(initiative.status).toLowerCase()}
          </>
        }
        title={initiative.name}
        actions={
          !readOnly && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('initiatives.detail.delete')}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: t('initiatives.detail.confirmDeleteTitle', { name: initiative.name }),
                    body: t('initiatives.detail.confirmDeleteBody'),
                    danger: true,
                  })
                )
                  remove.mutate(undefined, {
                    onSuccess: () =>
                      navigate({ to: '/$slug/initiatives', params: { slug: ws.slug } }),
                  });
              }}
            >
              <Trash2 size={13} />
            </button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-10 px-6 py-8 lg:grid-cols-[1fr_16rem]">
          <div className="min-w-0">
            <input
              value={name}
              disabled={readOnly}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== initiative.name && save.mutate({ name })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="w-full bg-transparent text-[28px] font-bold tracking-[-0.02em] outline-none"
              aria-label={t('initiatives.detail.nameLabel')}
            />
            <div className="mt-4">
              <ClickToEdit
                editing={editingDesc}
                onEdit={() => setEditingDesc(true)}
                disabled={readOnly}
                className="min-h-10"
                editor={
                  <>
                    <MarkdownEditor
                      value={desc}
                      onChange={setDesc}
                      autoFocus
                      minRows={4}
                      onSubmit={() => {
                        save.mutate({ description: desc });
                        setEditingDesc(false);
                      }}
                      onCancel={() => setEditingDesc(false)}
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setEditingDesc(false)}
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          save.mutate({ description: desc });
                          setEditingDesc(false);
                        }}
                      >
                        {t('common.save')}
                      </button>
                    </div>
                  </>
                }
              >
                {initiative.description?.trim() ? (
                  <Markdown source={initiative.description} />
                ) : (
                  <p className="text-index">
                    {readOnly ? '' : t('initiatives.detail.descriptionPlaceholder')}
                  </p>
                )}
              </ClickToEdit>
            </div>

            <div className="mt-8">
              <div className="section-label mb-3">{t('initiatives.detail.progress')}</div>
              <ProgressStats progress={initiative.progress} />
              <ProgressBar progress={initiative.progress} className="mt-3" />
            </div>

            <div className="mt-8">
              <div className="section-label mb-2">{t('initiatives.detail.projects')}</div>
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="row grid h-11 grid-cols-[minmax(0,1fr)_9rem_6rem_8rem_auto] items-center gap-3 border-b border-border-soft/60"
                >
                  <Link
                    to="/$slug/project/$projectId"
                    params={{ slug: ws.slug, projectId: p.id }}
                    search={{}}
                    className="flex min-w-0 items-center gap-2.5"
                  >
                    <ProjectIcon color={p.color} />
                    <span className="truncate text-[13.5px]">{p.name}</span>
                  </Link>
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                    <ProjectStatusIcon status={p.status} /> {projectStatusLabel(p.status)}
                  </span>
                  <span className="font-mono text-[11.5px] text-muted">
                    {p.targetDate ? shortDate(p.targetDate) : '—'}
                  </span>
                  <ProgressBar progress={p.progress} />
                  {!readOnly ? (
                    <button
                      type="button"
                      className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
                      onClick={() => moveProject.mutate({ id: p.id, initiativeId: null })}
                      aria-label={t('initiatives.detail.removeProject', { name: p.name })}
                    >
                      <X size={13} />
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
              {projects.length === 0 && (
                <p className="py-2 font-mono text-[12px] text-index">
                  {t('initiatives.detail.noProjects')}
                </p>
              )}
              {!readOnly && others.length > 0 && (
                <Picker
                  placeholder={t('initiatives.detail.addProjectPlaceholder')}
                  options={others.map((p) => ({
                    value: p.id,
                    label: p.name,
                    icon: <ProjectIcon color={p.color} />,
                    hint: p.initiativeId
                      ? ws.initiatives.find((i) => i.id === p.initiativeId)?.name
                      : undefined,
                  }))}
                  selected={[]}
                  onSelect={(id) => moveProject.mutate({ id, initiativeId: initiative.id })}
                  trigger={
                    <button type="button" className="btn btn-ghost btn-sm mt-2">
                      <Plus size={13} /> {t('initiatives.detail.addProject')}
                    </button>
                  }
                />
              )}
            </div>
          </div>

          <aside>
            <div className="section-label mb-3">{t('initiatives.detail.properties')}</div>
            <fieldset disabled={readOnly} className="flex flex-col gap-3 text-[12.5px]">
              <label className="block text-index">
                {t('initiatives.detail.status')}
                <select
                  className="input mt-1 h-8"
                  value={initiative.status}
                  onChange={(e) => save.mutate({ status: e.target.value })}
                >
                  {INITIATIVE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {initiativeStatusLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-index">
                {t('initiatives.detail.owner')}
                <div className="mt-1">
                  <Picker
                    placeholder={t('initiatives.detail.setOwner')}
                    options={assigneeOptions(ws)}
                    selected={[initiative.ownerId ?? 'none']}
                    onSelect={(v) => save.mutate({ ownerId: v === 'none' ? null : v })}
                    trigger={
                      <button type="button" className="prop w-full justify-start">
                        {owner ? (
                          <Avatar
                            name={owner.name}
                            color={owner.avatarColor}
                            src={owner.avatarUrl}
                            size={16}
                          />
                        ) : null}
                        {owner?.name ?? t('initiatives.detail.noOwner')}
                      </button>
                    }
                  />
                </div>
              </div>
              <label className="block text-index">
                {t('initiatives.detail.targetDate')}
                <input
                  type="date"
                  className="input mt-1 h-8 font-mono"
                  value={initiative.targetDate ?? ''}
                  onChange={(e) => save.mutate({ targetDate: e.target.value || null })}
                />
              </label>
              <div className="text-index">
                {t('initiatives.detail.color')}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {LABEL_COLORS.map((c) => (
                    <button
                      type="button"
                      key={c}
                      onClick={() => save.mutate({ color: c })}
                      className={`h-5 w-5 ${initiative.color === c ? 'outline-2 outline-offset-2 outline-text' : ''}`}
                      style={{ background: c }}
                      aria-label={t('initiatives.detail.colorLabel', { color: c })}
                    />
                  ))}
                </div>
              </div>
            </fieldset>
          </aside>
        </div>
      </div>
    </div>
  );
}
