import {
  type CustomField,
  type CustomFieldValue,
  dayInZone,
  ESTIMATE_SCALES,
  LABEL_COLORS,
  type Label,
  STATE_TYPES,
  type UpdateIssueInput,
} from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Hexagon, Milestone, Package, RefreshCcw, Tag, Users } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { keys } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { estimateLabel, priorityLabel } from '../i18n/labels.ts';
import { addDays, dueState, shortDate, today } from '../lib/format.ts';
import { isUnavailable, statusHint } from '../lib/status.ts';
import { cycleName, upcomingCycles, useWorkspace, type WorkspaceData } from '../lib/workspace.tsx';
import { PriorityIcon, ProjectIcon, StatusIcon, TeamIcon } from './icons.tsx';
import { Avatar, EmptyAvatar } from './ui/Avatar.tsx';
import { type Option, OptionList } from './ui/OptionList.tsx';
import { Popover } from './ui/Popover.tsx';

// ─── option builders (shared by pickers and the command palette) ───────

export function statusOptions(ws: WorkspaceData, teamId: string): Option[] {
  const team = ws.teamById.get(teamId);
  if (!team) return [];
  return [...team.states]
    .filter((s) => s.type !== 'triage' || team.triageEnabled)
    .sort(
      (a, b) =>
        STATE_TYPES.indexOf(a.type) - STATE_TYPES.indexOf(b.type) || a.position - b.position,
    )
    .map((s, i) => ({
      value: s.id,
      label: s.name,
      icon: <StatusIcon type={s.type} color={s.color} />,
      hint: i < 9 ? `${i + 1}` : undefined,
    }));
}

export const priorityOptions = (): Option[] =>
  [0, 1, 2, 3, 4].map((p) => ({
    value: String(p),
    label: priorityLabel(p),
    icon: <PriorityIcon priority={p} />,
    hint: String(p),
  }));

export const assigneeOptions = (ws: WorkspaceData): Option[] => [
  { value: 'none', label: t('issues.none.assignee'), icon: <EmptyAvatar size={16} /> },
  // You first, then people, then agents (assigning one hands the issue to its runner).
  ...[...ws.members]
    .sort((a, b) =>
      a.id === ws.me.id
        ? -1
        : b.id === ws.me.id
          ? 1
          : Number(a.kind === 'agent') - Number(b.kind === 'agent') || a.name.localeCompare(b.name),
    )
    .map((m) => ({
      value: m.id,
      label: m.id === ws.me.id ? t('issues.props.you', { name: m.name }) : m.name,
      keywords: `${m.username} ${m.email}`,
      icon: (
        <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={16} status={m.status} />
      ),
      ...(m.kind === 'agent' && { hint: t('agents.agentTag') }),
      // Say so before someone hands work to a person who won't see it soon.
      ...(isUnavailable(m.status) && { hint: statusHint(m.status!) }),
    })),
];

export const labelOptions = (ws: WorkspaceData, teamId?: string): Option[] =>
  ws.labels
    .filter((l) => !l.teamId || l.teamId === teamId)
    .map((l) => ({
      value: l.id,
      label: l.name,
      icon: <span className="tag-dot" style={{ background: l.color }} />,
    }));

export const projectOptions = (ws: WorkspaceData, teamId?: string): Option[] => [
  {
    value: 'none',
    label: t('issues.none.project'),
    icon: <Hexagon size={14} className="text-index" />,
  },
  ...ws.projects
    .filter((p) => !teamId || p.teamIds.includes(teamId))
    .filter((p) => p.status !== 'completed' && p.status !== 'canceled')
    .map((p) => ({ value: p.id, label: p.name, icon: <ProjectIcon color={p.color} /> })),
];

export const cycleOptions = (ws: WorkspaceData, teamId: string): Option[] => [
  {
    value: 'none',
    label: t('issues.none.cycle'),
    icon: <RefreshCcw size={14} className="text-index" />,
  },
  ...upcomingCycles(ws.cycles, teamId, dayInZone(ws.workspace.settings.timezone)).map((c) => ({
    value: c.id,
    label: cycleName(c),
    hint: `${shortDate(c.startsAt)} → ${shortDate(c.endsAt)}`,
    icon: <RefreshCcw size={14} className="text-muted" />,
  })),
];

export function estimateOptions(ws: WorkspaceData, teamId: string): Option[] {
  const team = ws.teamById.get(teamId);
  if (!team || team.estimateScale === 'none') return [];
  return [
    { value: 'none', label: t('enums.noEstimate') },
    ...ESTIMATE_SCALES[team.estimateScale].map((v) => ({
      value: String(v),
      label: estimateLabel(team.estimateScale, v),
    })),
  ];
}

export const teamOptions = (ws: WorkspaceData): Option[] =>
  ws.teams.map((team) => ({
    value: team.id,
    label: team.name,
    hint: team.key,
    icon: <TeamIcon color={team.color} label={team.key} />,
  }));

/** Converts a picked option value into an issue patch. */
export function patchFor(
  kind: PropKind,
  value: string,
  current?: { labelIds: string[] },
): UpdateIssueInput {
  const nullable = (v: string) => (v === 'none' ? null : v);
  switch (kind) {
    case 'status':
      return { stateId: value };
    case 'priority':
      return { priority: Number(value) };
    case 'assignee':
      return { assigneeId: nullable(value) };
    case 'project':
      return { projectId: nullable(value) };
    case 'cycle':
      return { cycleId: nullable(value) };
    case 'estimate':
      return { estimate: value === 'none' ? null : Number(value) };
    case 'team':
      return { teamId: value };
    case 'labels': {
      const has = current?.labelIds.includes(value);
      return has ? { removeLabelIds: [value] } : { addLabelIds: [value] };
    }
  }
}

export type PropKind =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'project'
  | 'cycle'
  | 'estimate'
  | 'team';

// ─── pickers ───────────────────────────────────────────────────────────

interface PickerProps {
  trigger: ReactNode;
  options: Option[];
  selected: string[];
  multi?: boolean;
  placeholder: string;
  onSelect: (value: string) => void;
  onCreate?: (q: string) => void;
  width?: number;
}

export function Picker({
  trigger,
  options,
  selected,
  multi,
  placeholder,
  onSelect,
  onCreate,
  width = 260,
}: PickerProps) {
  return (
    <Popover trigger={trigger} width={width}>
      {(close) => (
        <OptionList
          options={options}
          selected={selected}
          multi={multi}
          placeholder={placeholder}
          onSelect={onSelect}
          onClose={close}
          onCreate={onCreate}
          createLabel={(q) => t('issues.props.createLabel', { name: q })}
        />
      )}
    </Popover>
  );
}

export interface IssueLike {
  teamId: string;
  stateId: string;
  priority: number;
  assigneeId: string | null;
  labelIds: string[];
  projectId: string | null;
  cycleId: string | null;
  estimate: number | null;
  dueDate: string | null;
}

type Variant = 'chip' | 'icon' | 'field';

interface IssuePropProps {
  issue: IssueLike;
  onPatch: (patch: UpdateIssueInput) => void;
  variant?: Variant;
}

const fieldCls =
  'prop w-full min-w-0 justify-start bg-transparent shadow-none hover:bg-text/[0.03]';
const cls = (variant: Variant) =>
  variant === 'field'
    ? fieldCls
    : variant === 'icon'
      ? 'inline-flex h-6 w-6 items-center justify-center hover:bg-text/5'
      : 'prop';

export function StatusProp({ issue, onPatch, variant = 'chip' }: IssuePropProps) {
  const ws = useWorkspace();
  const state = ws.stateById.get(issue.stateId);
  return (
    <Picker
      placeholder={t('issues.props.changeStatus')}
      options={statusOptions(ws, issue.teamId)}
      selected={[issue.stateId]}
      onSelect={(v) => onPatch({ stateId: v })}
      trigger={
        <button
          type="button"
          className={cls(variant)}
          title={state?.name}
          aria-label={t('issues.props.statusIs', { status: state?.name ?? '' })}
        >
          {state && <StatusIcon type={state.type} color={state.color} />}
          {variant !== 'icon' && <span>{state?.name}</span>}
        </button>
      }
    />
  );
}

export function PriorityProp({ issue, onPatch, variant = 'chip' }: IssuePropProps) {
  return (
    <Picker
      placeholder={t('issues.props.setPriority')}
      options={priorityOptions()}
      selected={[String(issue.priority)]}
      onSelect={(v) => onPatch({ priority: Number(v) })}
      width={220}
      trigger={
        <button
          type="button"
          className={cls(variant)}
          title={priorityLabel(issue.priority)}
          aria-label={t('issues.props.priorityIs', { priority: priorityLabel(issue.priority) })}
        >
          <PriorityIcon priority={issue.priority} />
          {variant !== 'icon' && (
            <span>
              {issue.priority === 0 && variant === 'chip'
                ? t('common.priority')
                : priorityLabel(issue.priority)}
            </span>
          )}
        </button>
      }
    />
  );
}

export function AssigneeProp({ issue, onPatch, variant = 'chip' }: IssuePropProps) {
  const ws = useWorkspace();
  const m = issue.assigneeId ? ws.memberById.get(issue.assigneeId) : null;
  return (
    <Picker
      placeholder={t('issues.props.assignTo')}
      options={assigneeOptions(ws)}
      selected={[issue.assigneeId ?? 'none']}
      onSelect={(v) => onPatch({ assigneeId: v === 'none' ? null : v })}
      trigger={
        <button
          type="button"
          className={cls(variant)}
          title={m ? m.name : t('common.unassigned')}
          aria-label={m ? t('issues.props.assigneeIs', { name: m.name }) : t('common.unassigned')}
        >
          {m ? (
            <Avatar
              name={m.name}
              color={m.avatarColor}
              src={m.avatarUrl}
              size={variant === 'icon' ? 18 : 16}
              status={m.status}
            />
          ) : variant === 'icon' ? (
            <EmptyAvatar />
          ) : (
            <Users size={14} />
          )}
          {variant !== 'icon' && <span>{m ? m.name : t('common.assignee')}</span>}
        </button>
      }
    />
  );
}

export function LabelsProp({ issue, onPatch, variant = 'chip' }: IssuePropProps) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const selected = issue.labelIds.map((id) => ws.labelById.get(id)).filter((l): l is Label => !!l);
  const create = async (name: string) => {
    const color = LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)]!;
    const label = await api.post<Label>(wsPath(ws.slug, '/labels'), { name, color });
    await qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    onPatch({ addLabelIds: [label.id] });
  };
  return (
    <Picker
      multi
      placeholder={t('issues.props.addLabels')}
      options={labelOptions(ws, issue.teamId)}
      selected={issue.labelIds}
      onSelect={(v) => onPatch(patchFor('labels', v, issue))}
      onCreate={ws.isGuest ? undefined : create}
      trigger={
        variant === 'field' ? (
          <button
            type="button"
            className={`${fieldCls} h-auto min-h-[1.625rem] flex-wrap gap-1 py-1`}
          >
            {selected.length === 0 && (
              <>
                <Tag size={14} />
                <span>{t('issues.props.addLabel')}</span>
              </>
            )}
            {selected.map((l) => (
              <span key={l.id} className="tag">
                <span className="tag-dot" style={{ background: l.color }} />
                {l.name}
              </span>
            ))}
          </button>
        ) : (
          <button type="button" className={cls(variant)} aria-label={t('common.labels')}>
            <Tag size={14} />
            {variant === 'chip' && (
              <span>
                {selected.length
                  ? t('issues.props.labelCount', { count: selected.length })
                  : t('common.labels')}
              </span>
            )}
          </button>
        )
      }
    />
  );
}

/** The issue's milestone within its project; nothing to show without a project that has some. */
export function MilestoneProp({
  issue,
  onPatch,
  variant = 'chip',
}: {
  issue: { projectId: string | null; milestoneId: string | null };
  onPatch: (patch: UpdateIssueInput) => void;
  variant?: Variant;
}) {
  const ws = useWorkspace();
  const project = issue.projectId ? ws.projectById.get(issue.projectId) : null;
  if (!project || project.milestones.length === 0) return null;
  const current = project.milestones.find((m) => m.id === issue.milestoneId);
  return (
    <Picker
      placeholder={t('issues.props.setMilestone')}
      options={[
        {
          value: 'none',
          label: t('issues.none.milestone'),
          icon: <Milestone size={14} className="text-index" />,
        },
        ...project.milestones.map((m) => ({
          value: m.id,
          label: m.name,
          hint: m.targetDate ? shortDate(m.targetDate) : undefined,
          icon: <Milestone size={14} className="text-muted" />,
        })),
      ]}
      selected={[issue.milestoneId ?? 'none']}
      onSelect={(v) => onPatch({ milestoneId: v === 'none' ? null : v })}
      trigger={
        <button type="button" className={cls(variant)} aria-label={t('common.milestone')}>
          <Milestone size={14} />
          {variant !== 'icon' && (
            <span className="truncate">{current?.name ?? t('common.milestone')}</span>
          )}
        </button>
      }
    />
  );
}

export function ProjectProp({ issue, onPatch, variant = 'chip' }: IssuePropProps) {
  const ws = useWorkspace();
  const p = issue.projectId ? ws.projectById.get(issue.projectId) : null;
  return (
    <Picker
      placeholder={t('issues.props.setProject')}
      options={projectOptions(ws, issue.teamId)}
      selected={[issue.projectId ?? 'none']}
      onSelect={(v) => onPatch({ projectId: v === 'none' ? null : v })}
      trigger={
        <button type="button" className={cls(variant)} aria-label={t('common.project')}>
          {p ? <ProjectIcon color={p.color} /> : <Hexagon size={14} />}
          {variant !== 'icon' && (
            <span className="truncate">{p ? p.name : t('common.project')}</span>
          )}
        </button>
      }
    />
  );
}

export function CycleProp({ issue, onPatch, variant = 'chip' }: IssuePropProps) {
  const ws = useWorkspace();
  const team = ws.teamById.get(issue.teamId);
  if (!team?.cyclesEnabled) return null;
  const c = issue.cycleId ? ws.cycleById.get(issue.cycleId) : null;
  return (
    <Picker
      placeholder={t('issues.props.setCycle')}
      options={cycleOptions(ws, issue.teamId)}
      selected={[issue.cycleId ?? 'none']}
      onSelect={(v) => onPatch({ cycleId: v === 'none' ? null : v })}
      width={300}
      trigger={
        <button type="button" className={cls(variant)} aria-label={t('common.cycle')}>
          <RefreshCcw size={14} />
          {variant !== 'icon' && <span>{c ? cycleName(c) : t('common.cycle')}</span>}
        </button>
      }
    />
  );
}

/** Releases an issue of `teamId` can join: workspace-wide ones and its team's, not out yet. */
export function releaseOptions(ws: WorkspaceData, teamId: string): Option[] {
  return [
    {
      value: 'none',
      label: t('issues.none.release'),
      icon: <Package size={14} className="text-index" />,
    },
    ...ws.releases
      .filter((r) => !r.releasedAt && (!r.teamId || r.teamId === teamId))
      .map((r) => ({
        value: r.id,
        label: r.name,
        icon: <Package size={14} className="text-muted" />,
        hint: r.targetDate ? shortDate(r.targetDate) : undefined,
      })),
  ];
}

/**
 * The issue's release. Hidden while the team has none to pick; one that's out can't be left, so
 * it shows without a picker.
 */
export function ReleaseProp({
  issue,
  onPatch,
  variant = 'chip',
}: IssuePropProps & { issue: { releaseId?: string | null } }) {
  const ws = useWorkspace();
  const current = issue.releaseId ? ws.releaseById.get(issue.releaseId) : undefined;
  const options = releaseOptions(ws, issue.teamId);
  if (!current && options.length < 2) return null;
  const label = (
    <>
      <Package size={14} />
      {variant !== 'icon' && (
        <span className="truncate">{current?.name ?? t('common.release')}</span>
      )}
    </>
  );
  if (current?.releasedAt)
    return (
      <span className={cls(variant)} title={t('issues.props.releaseOut', { name: current.name })}>
        {label}
      </span>
    );
  return (
    <Picker
      placeholder={t('issues.props.setRelease')}
      options={options}
      selected={[issue.releaseId ?? 'none']}
      onSelect={(v) => onPatch({ releaseId: v === 'none' ? null : v })}
      width={260}
      trigger={
        <button type="button" className={cls(variant)} aria-label={t('common.release')}>
          {label}
        </button>
      }
    />
  );
}

export function EstimateProp({ issue, onPatch, variant = 'chip' }: IssuePropProps) {
  const ws = useWorkspace();
  const team = ws.teamById.get(issue.teamId);
  if (!team || team.estimateScale === 'none') return null;
  return (
    <Picker
      placeholder={t('issues.props.setEstimate')}
      options={estimateOptions(ws, issue.teamId)}
      selected={[issue.estimate == null ? 'none' : String(issue.estimate)]}
      onSelect={(v) => onPatch({ estimate: v === 'none' ? null : Number(v) })}
      width={200}
      trigger={
        <button type="button" className={cls(variant)} aria-label={t('common.estimate')}>
          <span className="font-mono text-[11px]">◇</span>
          <span>
            {issue.estimate == null
              ? variant === 'field'
                ? t('enums.noEstimate')
                : t('common.estimate')
              : estimateLabel(team.estimateScale, issue.estimate)}
          </span>
        </button>
      }
    />
  );
}

export function DueDateProp({
  issue,
  onPatch,
  variant = 'chip',
  done = false,
}: IssuePropProps & { done?: boolean }) {
  const state = dueState(issue.dueDate, done);
  const color = state === 'overdue' ? 'text-error' : state === 'soon' ? 'text-warning' : '';
  return (
    <Popover
      width={240}
      trigger={
        <button
          type="button"
          className={`${cls(variant)} ${color}`}
          aria-label={t('common.dueDate')}
        >
          <CalendarDays size={14} />
          <span>
            {issue.dueDate
              ? shortDate(issue.dueDate)
              : variant === 'field'
                ? t('common.noDueDate')
                : t('common.dueDate')}
          </span>
        </button>
      }
    >
      {(close) => (
        <DateChoices
          value={issue.dueDate}
          clearLabel={t('issues.props.clearDueDate')}
          onPick={(dueDate) => {
            onPatch({ dueDate });
            close();
          }}
        />
      )}
    </Popover>
  );
}

/** A date input with shortcuts (today, tomorrow, in a week) and a clear button. */
function DateChoices({
  value,
  clearLabel,
  onPick,
}: {
  value: string | null;
  clearLabel: string;
  onPick: (date: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1 p-2">
      <input
        type="date"
        className="input"
        autoFocus
        defaultValue={value ?? ''}
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
      />
      {[
        [t('issues.props.today'), today()],
        [t('issues.props.tomorrow'), addDays(today(), 1)],
        [t('issues.props.inAWeek'), addDays(today(), 7)],
      ].map(([label, date]) => (
        <button type="button" key={label} className="menu-item" onClick={() => onPick(date!)}>
          {label}
          <span className="ml-auto text-[11px] text-index">{shortDate(date!)}</span>
        </button>
      ))}
      {value && (
        <button type="button" className="menu-item text-error" onClick={() => onPick(null)}>
          {clearLabel}
        </button>
      )}
    </div>
  );
}

// ─── custom fields ─────────────────────────────────────────────────────

export const fieldOptionChoices = (field: CustomField): Option[] =>
  field.options.map((o) => ({
    value: o.id,
    label: o.name,
    icon: <span className="tag-dot" style={{ background: o.color }} />,
  }));

/** Members to pick for a person field: like the assignee picker, without its "no assignee". */
export const personChoices = (ws: WorkspaceData): Option[] =>
  assigneeOptions(ws).filter((o) => o.value !== 'none');

interface FieldPropProps {
  field: CustomField;
  issue: { teamId: string; customFields?: Record<string, CustomFieldValue> };
  onPatch: (patch: UpdateIssueInput) => void;
}

const setField = (field: CustomField, value: CustomFieldValue | null): UpdateIssueInput => ({
  customFields: { [field.id]: value },
});

const notSet = () => <span className="text-index">{t('customFields.props.notSet')}</span>;

/** The editor for one custom field's value, as a row of the issue's properties. */
export function CustomFieldProp({ field, issue, onPatch }: FieldPropProps) {
  const ws = useWorkspace();
  const value = issue.customFields?.[field.id];
  const none = t('customFields.props.none', { field: field.name });
  const placeholder = t('customFields.props.set', { field: field.name });
  const title = field.description ?? undefined;
  switch (field.type) {
    case 'select': {
      const option = field.options.find((o) => o.id === value);
      return (
        <Picker
          placeholder={placeholder}
          options={[
            { value: 'none', label: none, icon: <span className="tag-dot bg-border" /> },
            ...fieldOptionChoices(field),
          ]}
          selected={[option ? option.id : 'none']}
          onSelect={(v) => onPatch(setField(field, v === 'none' ? null : v))}
          trigger={
            <button type="button" className={fieldCls} title={title} aria-label={field.name}>
              {option ? (
                <>
                  <span className="tag-dot" style={{ background: option.color }} />
                  <span className="truncate">{option.name}</span>
                </>
              ) : (
                notSet()
              )}
            </button>
          }
        />
      );
    }
    case 'multi_select': {
      const ids = Array.isArray(value) ? value : [];
      const chosen = field.options.filter((o) => ids.includes(o.id));
      return (
        <Picker
          multi
          placeholder={placeholder}
          options={fieldOptionChoices(field)}
          selected={ids}
          onSelect={(v) => {
            const next = ids.includes(v) ? ids.filter((x) => x !== v) : [...ids, v];
            onPatch(setField(field, next.length ? next : null));
          }}
          trigger={
            <button
              type="button"
              className={`${fieldCls} h-auto min-h-[1.625rem] flex-wrap gap-1 py-1`}
              title={title}
              aria-label={field.name}
            >
              {chosen.length === 0 && notSet()}
              {chosen.map((o) => (
                <span key={o.id} className="tag">
                  <span className="tag-dot" style={{ background: o.color }} />
                  {o.name}
                </span>
              ))}
            </button>
          }
        />
      );
    }
    case 'person': {
      const person = typeof value === 'string' ? ws.memberById.get(value) : undefined;
      return (
        <Picker
          placeholder={placeholder}
          options={[
            { value: 'none', label: none, icon: <EmptyAvatar size={16} /> },
            ...personChoices(ws),
          ]}
          selected={[typeof value === 'string' ? value : 'none']}
          onSelect={(v) => onPatch(setField(field, v === 'none' ? null : v))}
          trigger={
            <button type="button" className={fieldCls} title={title} aria-label={field.name}>
              {typeof value === 'string' ? (
                <>
                  <Avatar
                    name={person?.name ?? '?'}
                    color={person?.avatarColor ?? 'var(--color-border)'}
                    src={person?.avatarUrl}
                    size={16}
                    status={person?.status}
                  />
                  <span className="truncate">
                    {person?.name ?? t('customFields.props.someone')}
                  </span>
                </>
              ) : (
                notSet()
              )}
            </button>
          }
        />
      );
    }
    case 'date': {
      const date = typeof value === 'string' ? value : null;
      return (
        <Popover
          width={240}
          trigger={
            <button type="button" className={fieldCls} title={title} aria-label={field.name}>
              <CalendarDays size={14} />
              {date ? <span>{shortDate(date)}</span> : notSet()}
            </button>
          }
        >
          {(close) => (
            <DateChoices
              value={date}
              clearLabel={t('customFields.props.clear', { field: field.name })}
              onPick={(d) => {
                onPatch(setField(field, d));
                close();
              }}
            />
          )}
        </Popover>
      );
    }
    case 'number':
    case 'text':
      return (
        <InlineValue
          // Remount when the value changes elsewhere, so the draft starts from it.
          key={String(value ?? '')}
          field={field}
          value={value === undefined ? '' : String(value)}
          onCommit={(v) => onPatch(setField(field, v))}
        />
      );
  }
}

/** A number or text value, edited in place: saved on Enter or leaving the box, Escape undoes. */
function InlineValue({
  field,
  value,
  onCommit,
}: {
  field: CustomField;
  value: string;
  onCommit: (v: CustomFieldValue | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const numeric = field.type === 'number';
  // Escape blurs too; this keeps that blur from saving the draft.
  const cancelled = useRef(false);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const text = draft.trim();
    if (text === value.trim()) return;
    if (!text) return onCommit(null);
    if (!numeric) return onCommit(text);
    const n = Number(text);
    if (Number.isFinite(n)) onCommit(n);
    else setDraft(value);
  };
  return (
    <input
      type={numeric ? 'number' : 'text'}
      inputMode={numeric ? 'decimal' : undefined}
      step="any"
      className="h-[1.625rem] w-full min-w-0 bg-transparent px-2 text-[12px] text-muted outline-none focus:text-text placeholder:text-index hover:bg-text/[0.03] focus:shadow-[inset_0_-1px_0_var(--color-primary)]"
      value={draft}
      placeholder={t(
        numeric ? 'customFields.props.numberPlaceholder' : 'customFields.props.textPlaceholder',
      )}
      title={field.description ?? (numeric ? undefined : value)}
      aria-label={field.name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
