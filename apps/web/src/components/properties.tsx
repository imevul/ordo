import {
  ESTIMATE_SCALES,
  LABEL_COLORS,
  type Label,
  STATE_TYPES,
  type UpdateIssueInput,
} from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Hexagon, Milestone, RefreshCcw, Tag, Users } from 'lucide-react';
import type { ReactNode } from 'react';
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
  ...upcomingCycles(ws.cycles, teamId).map((c) => ({
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

const fieldCls = 'prop w-full justify-start bg-transparent shadow-none hover:bg-text/[0.03]';
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
        <div className="flex flex-col gap-1 p-2">
          <input
            type="date"
            className="input"
            autoFocus
            defaultValue={issue.dueDate ?? ''}
            onChange={(e) => {
              if (e.target.value) {
                onPatch({ dueDate: e.target.value });
                close();
              }
            }}
          />
          {[
            [t('issues.props.today'), today()],
            [t('issues.props.tomorrow'), addDays(today(), 1)],
            [t('issues.props.inAWeek'), addDays(today(), 7)],
          ].map(([label, value]) => (
            <button
              type="button"
              key={label}
              className="menu-item"
              onClick={() => {
                onPatch({ dueDate: value });
                close();
              }}
            >
              {label}
              <span className="ml-auto text-[11px] text-index">{shortDate(value!)}</span>
            </button>
          ))}
          {issue.dueDate && (
            <button
              type="button"
              className="menu-item text-error"
              onClick={() => {
                onPatch({ dueDate: null });
                close();
              }}
            >
              {t('issues.props.clearDueDate')}
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
