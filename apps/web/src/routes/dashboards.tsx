import type { Dashboard, DashboardWidget } from '@ordo/shared';
import { DASHBOARD_COLUMNS, DASHBOARD_MAX_ROWS, DASHBOARD_MAX_WIDGETS } from '@ordo/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  GripVertical,
  LayoutDashboard,
  Lock,
  Pencil,
  Plus,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { WidgetEditor } from '../components/dashboard/WidgetEditor.tsx';
import { GAP_PX, ROW_PX, WidgetBody, widgetTitle } from '../components/dashboard/Widgets.tsx';
import { EmptyState, PageHeader, Sep } from '../components/PageHeader.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { ConfirmModal, Modal } from '../components/ui/Modal.tsx';
import { t } from '../i18n/index.ts';
import { dropWidget, moveWidget, putWidget, resizeWidget, spanClass } from '../lib/dashboards.ts';
import { relativeTime } from '../lib/format.ts';
import { useHotkey } from '../lib/hotkeys.ts';
import { useWorkspace, type WorkspaceData } from '../lib/workspace.tsx';

/** Who may change a dashboard: its owner, admins, and a team's admins for its shared ones. */
const canEdit = (ws: WorkspaceData, d: Dashboard) =>
  d.ownerId === ws.me.id || ws.isAdmin || (!!d.teamId && d.shared && ws.canAdminTeam(d.teamId));

/** Name, team and sharing: for a new dashboard, or an existing one's settings. */
function DashboardForm({ dashboard, onClose }: { dashboard?: Dashboard; onClose: () => void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState(dashboard?.name ?? '');
  const [description, setDescription] = useState(dashboard?.description ?? '');
  const [teamId, setTeamId] = useState(dashboard?.teamId ?? '');
  const [shared, setShared] = useState(dashboard?.shared ?? true);
  // Only the owner (or an admin) decides who sees it.
  const mayShare = !dashboard || dashboard.ownerId === ws.me.id || ws.isAdmin;
  const save = useWsMutation(
    ws.slug,
    (body: object) =>
      dashboard
        ? api.patch<Dashboard>(wsPath(ws.slug, `/dashboards/${dashboard.id}`), body)
        : api.post<Dashboard>(wsPath(ws.slug, '/dashboards'), body),
    { success: dashboard ? t('dashboards.form.saved') : t('dashboards.form.created') },
  );
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const body = dashboard
      ? { name, description: description || null, ...(mayShare ? { shared } : {}) }
      : { name, description: description || null, teamId: teamId || null, shared };
    save.mutate(body, {
      onSuccess: (d) => {
        onClose();
        if (!dashboard)
          navigate({
            to: '/$slug/dashboard/$dashboardId',
            params: { slug: ws.slug, dashboardId: d.id },
          });
      },
    });
  };
  const title = dashboard ? t('dashboards.form.editTitle') : t('dashboards.form.newTitle');
  return (
    <Modal open onClose={onClose} width={480} label={title} align="center">
      <form onSubmit={submit} className="p-6">
        <div className="section-label mb-4">{title}</div>
        <label className="block text-[12px] text-muted">
          {t('dashboards.form.name')}
          <input
            className="input mt-1"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('dashboards.form.namePlaceholder')}
          />
        </label>
        <label className="mt-4 block text-[12px] text-muted">
          {t('dashboards.form.description')}
          <input
            className="input mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {!dashboard && (
          <label className="mt-4 block text-[12px] text-muted">
            {t('dashboards.form.team')}
            <select
              className="input mt-1"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">{t('dashboards.form.workspace')}</option>
              {ws.teams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {mayShare && (
          <label className="mt-4 flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
              className="accent-primary"
            />
            {teamId ? t('dashboards.form.shareTeam') : t('dashboards.form.share')}
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || save.isPending}>
            {dashboard ? t('common.save') : t('dashboards.form.create')}{' '}
            <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DashboardsPage() {
  const ws = useWorkspace();
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {ws.workspace.name}
            <Sep />
            {t('dashboards.list.kicker')}
          </>
        }
        title={t('dashboards.list.title')}
        actions={
          !ws.isGuest && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setCreating(true)}
            >
              <Plus size={13} /> {t('dashboards.list.new')}
            </button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ws.dashboards.length === 0 ? (
          <EmptyState
            title={t('dashboards.list.emptyTitle')}
            body={t('dashboards.list.emptyBody')}
          />
        ) : (
          ws.dashboards.map((d) => {
            const owner = d.ownerId ? ws.memberById.get(d.ownerId) : undefined;
            const team = d.teamId ? ws.teamById.get(d.teamId) : null;
            return (
              <Link
                key={d.id}
                to="/$slug/dashboard/$dashboardId"
                params={{ slug: ws.slug, dashboardId: d.id }}
                className="row flex h-12 items-center gap-3 border-b border-border-soft/60 px-4"
              >
                <LayoutDashboard size={15} className="text-muted" />
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{d.name}</span>
                <span className="hidden font-mono text-[11px] text-index sm:block">
                  {t('dashboards.list.widgets', { count: d.widgets.length })}
                </span>
                {team && <span className="tag font-mono">{team.key}</span>}
                {!d.shared && (
                  <span className="tag">
                    <Lock size={11} /> {t('dashboards.list.private')}
                  </span>
                )}
                {owner && (
                  <Avatar
                    name={owner.name}
                    color={owner.avatarColor}
                    src={owner.avatarUrl}
                    size={16}
                  />
                )}
                <span className="hidden w-20 text-right font-mono text-[11px] text-index sm:block">
                  {relativeTime(d.updatedAt)}
                </span>
              </Link>
            );
          })
        )}
      </div>
      {creating && <DashboardForm onClose={() => setCreating(false)} />}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex h-6 w-6 items-center justify-center text-index hover:text-text disabled:opacity-30"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

/** A widget's frame: its title, and the layout controls while editing. */
function WidgetCard({
  widget,
  editing,
  index,
  count,
  onChange,
  onEdit,
  onRemove,
  onDrop,
}: {
  widget: DashboardWidget;
  editing: boolean;
  index: number;
  count: number;
  onChange: (f: (list: DashboardWidget[]) => DashboardWidget[]) => void;
  onEdit: () => void;
  onRemove: () => void;
  onDrop: (draggedId: string) => void;
}) {
  const ws = useWorkspace();
  const [over, setOver] = useState(false);
  const title = widgetTitle(ws, widget);
  const step = 'font-mono text-[10.5px] text-index';
  return (
    <section
      className={`col-span-1 flex min-h-0 min-w-0 flex-col border bg-surface p-4 ${spanClass(widget)} ${over ? 'border-primary' : editing ? 'border-dashed border-border' : 'border-border-soft'}`}
      aria-label={title}
      draggable={editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-ordo-widget', widget.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!editing || !e.dataTransfer.types.includes('text/x-ordo-widget')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData('text/x-ordo-widget');
        if (id && id !== widget.id) onDrop(id);
      }}
    >
      <div className="mb-2 flex min-h-6 flex-none flex-wrap items-center gap-1">
        {editing && <GripVertical size={13} className="flex-none cursor-grab text-index" />}
        <h3 className="kicker min-w-[7rem] flex-1 truncate text-[11px] uppercase tracking-[0.14em]">
          {title}
        </h3>
        {editing && (
          <div className="flex flex-none flex-wrap items-center justify-end">
            <IconButton
              label={t('dashboards.widget.moveEarlier')}
              onClick={() => onChange((l) => moveWidget(l, widget.id, -1))}
              disabled={index === 0}
            >
              <ArrowLeft size={13} />
            </IconButton>
            <IconButton
              label={t('dashboards.widget.moveLater')}
              onClick={() => onChange((l) => moveWidget(l, widget.id, 1))}
              disabled={index === count - 1}
            >
              <ArrowRight size={13} />
            </IconButton>
            <IconButton
              label={t('dashboards.widget.narrower')}
              onClick={() => onChange((l) => resizeWidget(l, widget.id, { w: -1 }))}
              disabled={widget.w <= 1}
            >
              <span className={step}>W−</span>
            </IconButton>
            <IconButton
              label={t('dashboards.widget.wider')}
              onClick={() => onChange((l) => resizeWidget(l, widget.id, { w: 1 }))}
              disabled={widget.w >= DASHBOARD_COLUMNS}
            >
              <span className={step}>W+</span>
            </IconButton>
            <IconButton
              label={t('dashboards.widget.shorter')}
              onClick={() => onChange((l) => resizeWidget(l, widget.id, { h: -1 }))}
              disabled={widget.h <= 1}
            >
              <span className={step}>H−</span>
            </IconButton>
            <IconButton
              label={t('dashboards.widget.taller')}
              onClick={() => onChange((l) => resizeWidget(l, widget.id, { h: 1 }))}
              disabled={widget.h >= DASHBOARD_MAX_ROWS}
            >
              <span className={step}>H+</span>
            </IconButton>
            <IconButton label={t('dashboards.widget.edit')} onClick={onEdit}>
              <Pencil size={12} />
            </IconButton>
            <IconButton label={t('dashboards.widget.remove')} onClick={onRemove}>
              <X size={13} />
            </IconButton>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <WidgetBody widget={widget} />
      </div>
    </section>
  );
}

export function DashboardPage() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { dashboardId } = useParams({ from: '/$slug/dashboard/$dashboardId' });
  const dashboard = ws.dashboardById.get(dashboardId);
  // While editing, the layout is a draft until it's saved.
  const [draft, setDraft] = useState<DashboardWidget[] | null>(null);
  // The widget in the editor: null adds one; undefined is closed.
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | null | undefined>();
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const fav = ws.favorites.find((f) => f.kind === 'dashboard' && f.targetId === dashboardId);
  const toggleFav = useWsMutation(ws.slug, () =>
    fav
      ? api.del(wsPath(ws.slug, `/favorites/${fav.id}`))
      : api.post(wsPath(ws.slug, '/favorites'), { kind: 'dashboard', targetId: dashboardId }),
  );
  const saveLayout = useWsMutation(
    ws.slug,
    (widgets: DashboardWidget[]) =>
      api.patch(wsPath(ws.slug, `/dashboards/${dashboardId}`), { widgets }),
    { success: t('dashboards.page.saved') },
  );
  const remove = useWsMutation(
    ws.slug,
    () => api.del(wsPath(ws.slug, `/dashboards/${dashboardId}`)),
    { success: t('dashboards.page.deleted') },
  );
  const editable = !!dashboard && canEdit(ws, dashboard);
  const editing = draft !== null;
  const widgets = draft ?? dashboard?.widgets ?? [];
  const full = widgets.length >= DASHBOARD_MAX_WIDGETS;

  const save = () => {
    if (!draft) return;
    saveLayout.mutate(draft, { onSuccess: () => setDraft(null) });
  };
  const startEditing = () => dashboard && setDraft(dashboard.widgets);
  useHotkey('e', () => (editing ? save() : startEditing()), { enabled: editable });
  useHotkey('a', () => !full && setEditingWidget(null), { enabled: editing });

  if (!dashboard) return <EmptyState title={t('dashboards.page.notFound')} />;
  const team = dashboard.teamId ? ws.teamById.get(dashboard.teamId) : undefined;
  const change = (f: (list: DashboardWidget[]) => DashboardWidget[]) =>
    setDraft((d) => f(d ?? dashboard.widgets));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            {t('dashboards.page.kicker')}
            {team && (
              <>
                <Sep />
                {team.key}
              </>
            )}
            <Sep />
            {dashboard.shared ? t('dashboards.page.shared') : t('dashboards.page.private')}
          </>
        }
        title={dashboard.name}
        actions={
          editing ? (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setEditingWidget(null)}
                disabled={full}
                title={
                  full ? t('dashboards.page.full', { count: DASHBOARD_MAX_WIDGETS }) : undefined
                }
              >
                <Plus size={13} /> {t('dashboards.page.addWidget')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={save}
                disabled={saveLayout.isPending}
              >
                {t('dashboards.page.saveLayout')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => toggleFav.mutate(undefined)}
                aria-pressed={!!fav}
                aria-label={t('dashboards.page.favorite')}
              >
                <Star size={13} className={fav ? 'fill-primary text-primary' : ''} />
              </button>
              {editable && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setSettings(true)}
                    aria-label={t('dashboards.page.settings')}
                  >
                    <Settings2 size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => setConfirm(true)}
                    aria-label={t('dashboards.page.delete')}
                  >
                    <Trash2 size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={startEditing}
                    aria-label={t('dashboards.page.editLayout')}
                  >
                    <Pencil size={13} />
                    <span className="hidden sm:inline">{t('dashboards.page.editLayout')}</span>
                  </button>
                </>
              )}
            </>
          )
        }
      >
        {dashboard.description && (
          <p className="truncate px-4 pb-2 text-[12.5px] text-muted">{dashboard.description}</p>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {widgets.length === 0 ? (
          <EmptyState
            title={t('dashboards.page.emptyTitle')}
            body={
              editable ? t('dashboards.page.emptyBody') : t('dashboards.page.emptyBodyReadOnly')
            }
            action={
              editable && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    if (!editing) startEditing();
                    setEditingWidget(null);
                  }}
                >
                  <Plus size={13} /> {t('dashboards.page.addWidget')}
                </button>
              )
            }
          />
        ) : (
          <div
            className="grid grid-flow-row-dense grid-cols-1 md:grid-cols-4"
            style={{ gridAutoRows: `${ROW_PX}px`, gap: GAP_PX }}
          >
            {widgets.map((w, i) => (
              <WidgetCard
                key={w.id}
                widget={w}
                editing={editing}
                index={i}
                count={widgets.length}
                onChange={change}
                onEdit={() => setEditingWidget(w)}
                onRemove={() => change((l) => l.filter((x) => x.id !== w.id))}
                onDrop={(id) => change((l) => dropWidget(l, id, w.id))}
              />
            ))}
          </div>
        )}
      </div>
      {editingWidget !== undefined && (
        <WidgetEditor
          widget={editingWidget}
          onClose={() => setEditingWidget(undefined)}
          onSave={(w) => {
            change((l) => putWidget(l, w));
            setEditingWidget(undefined);
          }}
        />
      )}
      {settings && <DashboardForm dashboard={dashboard} onClose={() => setSettings(false)} />}
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('dashboards.page.confirmDeleteTitle', { name: dashboard.name })}
        body={t('dashboards.page.confirmDeleteBody')}
        confirmLabel={t('dashboards.page.delete')}
        danger
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => navigate({ to: '/$slug/dashboards', params: { slug: ws.slug } }),
          })
        }
      />
    </div>
  );
}
