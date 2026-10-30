import {
  type IssueTemplate,
  RECURRENCE_UNITS,
  type RecurrenceUnit,
  type RecurringIssue,
} from '@ordo/shared';
import { Hexagon, Pencil, Plus, Repeat, Tag, Trash2, User, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { PriorityIcon, StatusIcon, TeamIcon } from '../../components/icons.tsx';
import { MarkdownEditor } from '../../components/MarkdownEditor.tsx';
import {
  assigneeOptions,
  estimateOptions,
  labelOptions,
  Picker,
  priorityOptions,
  projectOptions,
  statusOptions,
} from '../../components/properties.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { priorityLabel } from '../../i18n/labels.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard, TeamSelect } from './ui.tsx';

type Draft = Omit<IssueTemplate, 'id' | 'createdById' | 'updatedAt'>;

const EMPTY: Draft = {
  teamId: null,
  name: '',
  title: '',
  description: '',
  stateId: null,
  priority: null,
  assigneeId: null,
  projectId: null,
  estimate: null,
  labelIds: [],
};

/** The "leave it as it is" option for a template default. */
const unset = (label: string) => ({ value: 'none', label, icon: <span className="w-3.5" /> });

/** A picker trigger; a plain element, since the popover attaches its handlers to it. */
const chip = (icon: ReactNode, text: ReactNode) => (
  <button type="button" className="prop">
    {icon}
    <span className="truncate">{text}</span>
  </button>
);

function TemplateEditor({ template, onClose }: { template?: IssueTemplate; onClose: () => void }) {
  const ws = useWorkspace();
  const [draft, setDraft] = useState<Draft>(template ?? EMPTY);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = useWsMutation(ws.slug, () => {
    const { teamId, ...fields } = draft;
    return template
      ? api.patch(wsPath(ws.slug, `/templates/${template.id}`), fields)
      : api.post(wsPath(ws.slug, '/templates'), draft);
  });
  const teamId = draft.teamId ?? undefined;
  const state = draft.stateId ? ws.stateById.get(draft.stateId) : null;
  const assignee = draft.assigneeId ? ws.memberById.get(draft.assigneeId) : null;
  const project = draft.projectId ? ws.projectById.get(draft.projectId) : null;
  const labels = draft.labelIds.map((id) => ws.labelById.get(id)).filter((l) => !!l);
  const estimates = teamId ? estimateOptions(ws, teamId) : [];
  const nullable = (v: string) => (v === 'none' ? null : v);

  return (
    <Modal
      open
      onClose={onClose}
      width={680}
      label={template ? t('templates.editor.edit') : t('templates.editor.new')}
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.name.trim()) return;
          save.mutate(undefined, { onSuccess: onClose });
        }}
      >
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="kicker text-[11px] uppercase tracking-[0.14em]">
            {template ? t('templates.editor.edit') : t('templates.editor.new')}
          </span>
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2 px-4 pt-3">
          <input
            autoFocus
            className="input"
            placeholder={t('templates.editor.namePlaceholder')}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <TeamSelect
            className="input w-40"
            none={t('templates.editor.allTeams')}
            value={draft.teamId}
            disabled={!!template}
            title={template ? t('templates.editor.teamLocked') : undefined}
            onChange={(teamId) =>
              // Status, estimate and team labels belong to one team.
              set({
                teamId,
                stateId: null,
                estimate: null,
                labelIds: draft.labelIds.filter((id) => !ws.labelById.get(id)?.teamId),
              })
            }
            aria-label={t('common.team')}
          />
        </div>
        <div className="min-h-0 overflow-y-auto px-4">
          <input
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder={t('templates.editor.titlePlaceholder')}
            className="mt-4 w-full bg-transparent text-[18px] font-semibold tracking-[-0.01em] outline-none placeholder:text-index"
          />
          <MarkdownEditor
            bare
            value={draft.description}
            onChange={(description) => set({ description })}
            placeholder={t('templates.editor.descriptionPlaceholder')}
            minRows={5}
            className="mt-1 -mx-3"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          {teamId && (
            <Picker
              placeholder={t('templates.editor.statusPlaceholder')}
              options={[unset(t('templates.editor.teamDefault')), ...statusOptions(ws, teamId)]}
              selected={[draft.stateId ?? 'none']}
              onSelect={(v) => set({ stateId: nullable(v) })}
              trigger={chip(
                state ? <StatusIcon type={state.type} color={state.color} /> : null,
                state ? state.name : t('common.status'),
              )}
            />
          )}
          <Picker
            placeholder={t('templates.editor.priorityPlaceholder')}
            options={[unset(t('templates.editor.notSet')), ...priorityOptions()]}
            selected={[draft.priority == null ? 'none' : String(draft.priority)]}
            onSelect={(v) => set({ priority: v === 'none' ? null : Number(v) })}
            width={220}
            trigger={chip(
              draft.priority != null ? <PriorityIcon priority={draft.priority} /> : null,
              draft.priority != null ? priorityLabel(draft.priority) : t('common.priority'),
            )}
          />
          <Picker
            placeholder={t('templates.editor.assigneePlaceholder')}
            options={assigneeOptions(ws)}
            selected={[draft.assigneeId ?? 'none']}
            onSelect={(v) => set({ assigneeId: nullable(v) })}
            trigger={chip(<User size={14} />, assignee?.name ?? t('common.assignee'))}
          />
          <Picker
            multi
            placeholder={t('templates.editor.labelsPlaceholder')}
            options={labelOptions(ws, teamId)}
            selected={draft.labelIds}
            onSelect={(v) =>
              set({
                labelIds: draft.labelIds.includes(v)
                  ? draft.labelIds.filter((x) => x !== v)
                  : [...draft.labelIds, v],
              })
            }
            trigger={chip(
              <Tag size={14} />,
              labels.length ? labels.map((l) => l.name).join(', ') : t('common.labels'),
            )}
          />
          <Picker
            placeholder={t('templates.editor.projectPlaceholder')}
            options={projectOptions(ws, teamId)}
            selected={[draft.projectId ?? 'none']}
            onSelect={(v) => set({ projectId: nullable(v) })}
            trigger={chip(<Hexagon size={14} />, project?.name ?? t('common.project'))}
          />
          {estimates.length > 0 && (
            <Picker
              placeholder={t('templates.editor.estimatePlaceholder')}
              options={estimates}
              selected={[draft.estimate == null ? 'none' : String(draft.estimate)]}
              onSelect={(v) => set({ estimate: v === 'none' ? null : Number(v) })}
              width={200}
              trigger={chip(
                <span className="font-mono text-[11px]">◇</span>,
                estimates.find((o) => o.value === String(draft.estimate))?.label ??
                  t('common.estimate'),
              )}
            />
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border-soft px-4 py-3">
          <span className="font-mono text-[11px] text-index">{t('templates.editor.hint')}</span>
          <button type="button" className="btn btn-ghost ml-auto" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!draft.name.trim() || save.isPending}>
            {template ? t('common.save') : t('templates.editor.create')}{' '}
            <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

const cadence = (every: number, unit: RecurrenceUnit) =>
  t(`templates.cadence.${unit}`, { count: every });

/** Turns a template into an issue every so often, in one team. */
function RepeatModal({ template, onClose }: { template: IssueTemplate; onClose: () => void }) {
  const ws = useWorkspace();
  const [teamId, setTeamId] = useState(template.teamId ?? ws.myTeams[0]?.id ?? '');
  const [every, setEvery] = useState(1);
  const [unit, setUnit] = useState<RecurrenceUnit>('week');
  const [nextOn, setNextOn] = useState(new Date().toISOString().slice(0, 10));
  const create = useWsMutation(ws.slug, () =>
    api.post(wsPath(ws.slug, '/recurring'), {
      templateId: template.id,
      teamId,
      every,
      unit,
      nextOn,
    }),
  );
  return (
    <Modal open onClose={onClose} width={480} label={t('templates.repeat.label')}>
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined, { onSuccess: onClose });
        }}
      >
        <div className="section-label mb-1">
          {t('templates.repeat.title', { name: template.name })}
        </div>
        <p className="mb-4 text-[12.5px] text-muted">{t('templates.repeat.body')}</p>
        <div className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-3 text-[13px]">
          <span className="text-index">{t('templates.repeat.team')}</span>
          <TeamSelect value={teamId} disabled={!!template.teamId} onChange={setTeamId} />
          <span className="text-index">{t('templates.repeat.every')}</span>
          <span className="flex gap-2">
            <input
              type="number"
              min={1}
              max={52}
              className="input w-20 font-mono"
              value={every}
              onChange={(e) => setEvery(Math.max(1, Math.min(52, Number(e.target.value) || 1)))}
            />
            <select
              className="input flex-1"
              value={unit}
              onChange={(e) => setUnit(e.target.value as RecurrenceUnit)}
            >
              {RECURRENCE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`templates.unit.${u}`, { count: every })}
                </option>
              ))}
            </select>
          </span>
          <span className="text-index">{t('templates.repeat.firstOn')}</span>
          <input
            type="date"
            className="input font-mono"
            value={nextOn}
            onChange={(e) => setNextOn(e.target.value)}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!teamId || !nextOn || create.isPending}>
            {t('templates.repeat.submit')} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ScheduleRow({ schedule }: { schedule: RecurringIssue }) {
  const ws = useWorkspace();
  const team = ws.teamById.get(schedule.teamId);
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/recurring/${schedule.id}`), body),
  );
  const remove = useWsMutation(ws.slug, () =>
    api.del(wsPath(ws.slug, `/recurring/${schedule.id}`)),
  );
  return (
    <div className="flex h-8 items-center gap-2 pl-7 font-mono text-[11.5px] text-muted">
      <Repeat size={12} className={schedule.paused ? 'text-index' : 'text-primary'} />
      <span>
        {schedule.paused
          ? t('templates.schedule.paused', {
              cadence: cadence(schedule.every, schedule.unit),
              team: team?.key ?? '?',
            })
          : t('templates.schedule.next', {
              cadence: cadence(schedule.every, schedule.unit),
              team: team?.key ?? '?',
              date: schedule.nextOn,
            })}
      </span>
      {!ws.isGuest && (
        <span className="ml-auto flex gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => save.mutate({ paused: !schedule.paused })}
          >
            {schedule.paused ? t('templates.schedule.resume') : t('templates.schedule.pause')}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => remove.mutate(undefined)}
            aria-label={t('templates.schedule.stop')}
          >
            <X size={12} />
          </button>
        </span>
      )}
    </div>
  );
}

function TemplateRow({ template, onEdit }: { template: IssueTemplate; onEdit: () => void }) {
  const ws = useWorkspace();
  const [repeat, setRepeat] = useState(false);
  const schedules = ws.recurring.filter((r) => r.templateId === template.id);
  return (
    <div className="border-b border-border-soft">
      <TemplateLine template={template} onEdit={onEdit} onRepeat={() => setRepeat(true)} />
      {schedules.map((s) => (
        <ScheduleRow key={s.id} schedule={s} />
      ))}
      {repeat && <RepeatModal template={template} onClose={() => setRepeat(false)} />}
    </div>
  );
}

function TemplateLine({
  template,
  onEdit,
  onRepeat,
}: {
  template: IssueTemplate;
  onEdit: () => void;
  onRepeat: () => void;
}) {
  const ws = useWorkspace();
  const remove = useWsMutation(ws.slug, () =>
    api.del(wsPath(ws.slug, `/templates/${template.id}`)),
  );
  const team = template.teamId ? ws.teamById.get(template.teamId) : null;
  return (
    <div className="flex h-11 items-center gap-3">
      {team ? <TeamIcon color={team.color} label={team.key} size={16} /> : <span className="w-4" />}
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:text-primary"
        onClick={onEdit}
      >
        {template.name}
        {template.title && (
          <span className="ml-2 font-mono text-[11.5px] text-index">{template.title}</span>
        )}
      </button>
      <span className="tag font-mono">{team ? team.key : t('templates.allTeamsTag')}</span>
      {!ws.isGuest && (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onRepeat}
            aria-label={t('templates.repeatLabel', { name: template.name })}
            title={t('templates.repeatTitle')}
          >
            <Repeat size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onEdit}
            aria-label={t('templates.editLabel', { name: template.name })}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: t('templates.confirmDelete', { name: template.name }),
                  danger: true,
                })
              )
                remove.mutate(undefined);
            }}
            aria-label={t('templates.deleteLabel', { name: template.name })}
          >
            <Trash2 size={12} />
          </button>
        </>
      )}
    </div>
  );
}

export function TemplatesSection() {
  const ws = useWorkspace();
  const [editing, setEditing] = useState<IssueTemplate | 'new' | null>(null);
  return (
    <SettingsCard title={t('templates.title')} description={t('templates.description')}>
      {!ws.isGuest && (
        <button type="button" className="btn btn-primary mb-5" onClick={() => setEditing('new')}>
          <Plus size={13} /> {t('templates.newTemplate')}
        </button>
      )}
      {ws.templates.map((tpl) => (
        <TemplateRow key={tpl.id} template={tpl} onEdit={() => !ws.isGuest && setEditing(tpl)} />
      ))}
      {ws.templates.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('templates.empty')}</p>
      )}
      {editing && (
        <TemplateEditor
          template={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsCard>
  );
}
