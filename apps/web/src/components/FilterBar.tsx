import {
  type CustomField,
  DATE_RANGES,
  type DateFilter,
  type EstimateFilter,
  type IssueConditions,
  type IssueFilter,
  STATE_TYPES,
  type StateType,
} from '@ordo/shared';
import { ChevronRight, Filter, Plus, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { type MessageKey, t } from '../i18n/index.ts';
import { priorityLabel, priorityOptions, stateTypeLabel } from '../i18n/labels.ts';
import { fieldLabel, fieldsInScope, hasChoices, optionName } from '../lib/customFields.ts';
import {
  activeKeys,
  type ConditionKey,
  canToggleNegation,
  conditionValue,
  type FieldKey,
  type FlagKey,
  fieldIdOf,
  fieldKey,
  hasConditions,
  isDateKey,
  isFieldKey,
  isFlagKey,
  isListKey,
  type ListKey,
  setCondition,
  setExcluded,
  setGroup,
  toggleNegation,
} from '../lib/filters.ts';
import { cycleName, useWorkspace, type WorkspaceData } from '../lib/workspace.tsx';
import { PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';
import { fieldOptionChoices, labelOptions, statusOptions } from './properties.tsx';
import { Avatar, EmptyAvatar } from './ui/Avatar.tsx';
import { type Option, OptionList } from './ui/OptionList.tsx';
import { Popover } from './ui/Popover.tsx';

interface FilterDef {
  key: ConditionKey;
  /** Read at render time, after the catalogue has loaded. */
  label: () => string;
  /** For list filters: the values to pick from. */
  options?: (ws: WorkspaceData, teamId?: string) => Option[];
  /** For custom fields: how a value reads. Built-in lists use `listLabel`. */
  valueLabel?: (ws: WorkspaceData, value: string) => string;
  numeric?: boolean;
}

const memberOptions = (ws: WorkspaceData, none: string | null): Option[] => [
  {
    value: 'me',
    label: t('issues.filter.me'),
    icon: <Avatar name={ws.me.name} color={ws.me.avatarColor} src={ws.me.avatarUrl} size={16} />,
  },
  ...(none ? [{ value: 'none', label: none, icon: <EmptyAvatar size={16} /> }] : []),
  ...ws.members
    .filter((m) => m.id !== ws.me.id)
    .map((m) => ({
      value: m.id,
      label: m.name,
      icon: <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={16} />,
    })),
];

const FLAG_LABELS: Record<FlagKey, [MessageKey, MessageKey]> = {
  blocked: ['issues.filter.flag.blocked', 'issues.filter.notFlag.blocked'],
  blocking: ['issues.filter.flag.blocking', 'issues.filter.notFlag.blocking'],
  hasPullRequest: ['issues.filter.flag.hasPullRequest', 'issues.filter.notFlag.hasPullRequest'],
  hasSubIssues: ['issues.filter.flag.hasSubIssues', 'issues.filter.notFlag.hasSubIssues'],
  isSubIssue: ['issues.filter.flag.isSubIssue', 'issues.filter.notFlag.isSubIssue'],
};

const BUILTIN: (Omit<FilterDef, 'label'> & { label: MessageKey })[] = [
  {
    key: 'stateIds',
    label: 'common.status',
    options: (ws, teamId) => (teamId ? statusOptions(ws, teamId) : []),
  },
  {
    key: 'stateTypes',
    label: 'issues.filter.statusType',
    options: () =>
      STATE_TYPES.map((type) => ({
        value: type,
        label: stateTypeLabel(type),
        icon: <StatusIcon type={type} color="var(--color-muted)" />,
      })),
  },
  {
    key: 'priorities',
    label: 'common.priority',
    numeric: true,
    options: () =>
      priorityOptions().map((p) => ({
        value: String(p.value),
        label: p.label,
        icon: <PriorityIcon priority={p.value} />,
      })),
  },
  {
    key: 'assigneeIds',
    label: 'common.assignee',
    options: (ws) => memberOptions(ws, t('issues.none.assignee')),
  },
  { key: 'creatorIds', label: 'common.creator', options: (ws) => memberOptions(ws, null) },
  { key: 'labelIds', label: 'common.labels', options: (ws, teamId) => labelOptions(ws, teamId) },
  {
    key: 'projectIds',
    label: 'common.project',
    options: (ws) => [
      { value: 'none', label: t('issues.none.project') },
      ...ws.projects.map((p) => ({
        value: p.id,
        label: p.name,
        icon: <ProjectIcon color={p.color} />,
      })),
    ],
  },
  {
    key: 'milestoneIds',
    label: 'common.milestone',
    options: (ws) => [
      { value: 'none', label: t('issues.none.milestone') },
      ...ws.projects.flatMap((p) =>
        (p.milestones ?? []).map((m) => ({
          value: m.id,
          label: `${p.name} · ${m.name}`,
          icon: <ProjectIcon color={p.color} />,
        })),
      ),
    ],
  },
  {
    key: 'cycleIds',
    label: 'common.cycle',
    options: (ws, teamId) => [
      { value: 'none', label: t('issues.none.cycle') },
      ...ws.cycles
        .filter((c) => !teamId || c.teamId === teamId)
        .map((c) => ({
          value: c.id,
          label: `${teamId ? '' : `${ws.teamById.get(c.teamId)?.key} · `}${cycleName(c)}`,
        })),
    ],
  },
  { key: 'dueDate', label: 'common.dueDate' },
  { key: 'createdAt', label: 'issues.filter.created' },
  { key: 'updatedAt', label: 'issues.filter.updated' },
  { key: 'completedAt', label: 'issues.filter.completed' },
  { key: 'estimate', label: 'common.estimate' },
  ...(Object.keys(FLAG_LABELS) as FlagKey[]).map((key) => ({
    key,
    label: FLAG_LABELS[key][0],
  })),
];

const DEFS: FilterDef[] = BUILTIN.map((d) => ({ ...d, label: () => t(d.label) }));

const personLabel = (ws: WorkspaceData, v: string, none: string) =>
  v === 'me' ? t('issues.filter.me') : v === 'none' ? none : (ws.memberById.get(v)?.name ?? '?');

/**
 * A filter on a custom field. `field` is missing when the filter names a field that was deleted:
 * it still shows, so it can be removed.
 */
function fieldDef(ws: WorkspaceData, key: FieldKey, teamId?: string): FilterDef {
  const field: CustomField | undefined = ws.customFieldById.get(fieldIdOf(key));
  const name = field?.name ?? t('customFields.activity.deletedField');
  const none = t('customFields.props.none', { field: name });
  return {
    key,
    label: () => (field ? fieldLabel(ws, field, teamId) : name),
    options: (w) =>
      !field
        ? []
        : field.type === 'person'
          ? memberOptions(w, none)
          : [
              { value: 'none', label: none, icon: <span className="tag-dot bg-border" /> },
              ...fieldOptionChoices(field),
            ],
    valueLabel: (w, v) =>
      v === 'none'
        ? none
        : field?.type === 'person'
          ? personLabel(w, v, none)
          : optionName(field, v),
  };
}

/** What the "Filter" menu offers: the built-in filters, then custom fields with choices. */
function filterDefs(ws: WorkspaceData, teamId?: string): FilterDef[] {
  const builtin = DEFS.filter((d) => (teamId ? d.key !== 'stateTypes' : d.key !== 'stateIds'));
  const fields = fieldsInScope(ws.customFields, teamId)
    .filter(hasChoices)
    .map((f) => fieldDef(ws, fieldKey(f.id), teamId));
  return [...builtin, ...fields];
}

const defOf = (ws: WorkspaceData, key: ConditionKey, teamId?: string) =>
  isFieldKey(key) ? fieldDef(ws, key, teamId) : DEFS.find((d) => d.key === key)!;

function listLabel(ws: WorkspaceData, key: ListKey, v: string): string {
  switch (key) {
    case 'stateIds':
      return ws.stateById.get(v)?.name ?? '?';
    case 'stateTypes':
      return STATE_TYPES.includes(v as StateType) ? stateTypeLabel(v as StateType) : v;
    case 'priorities':
      return priorityLabel(Number(v));
    case 'assigneeIds':
    case 'creatorIds':
      return v === 'me'
        ? t('issues.filter.me')
        : v === 'none'
          ? t('issues.filter.nobody')
          : (ws.memberById.get(v)?.name ?? '?');
    case 'labelIds':
      return ws.labelById.get(v)?.name ?? '?';
    case 'projectIds':
      return v === 'none' ? t('issues.none.project') : (ws.projectById.get(v)?.name ?? '?');
    case 'milestoneIds': {
      if (v === 'none') return t('issues.none.milestone');
      const m = ws.projects.flatMap((p) => p.milestones ?? []).find((x) => x.id === v);
      return m?.name ?? '?';
    }
    case 'cycleIds': {
      if (v === 'none') return t('issues.none.cycle');
      const c = ws.cycleById.get(v);
      return c ? cycleName(c) : '?';
    }
  }
}

const rangeLabel = (range: (typeof DATE_RANGES)[number]) =>
  t(`issues.filter.range.${range}` as MessageKey);

function dateLabel(d: DateFilter): string {
  const parts: string[] = [];
  if (d.range) parts.push(rangeLabel(d.range));
  if (d.from) parts.push(t('issues.filter.fromDate', { date: d.from }));
  if (d.to) parts.push(t('issues.filter.toDate', { date: d.to }));
  return parts.join(', ') || rangeLabel('any');
}

function estimateLabel(e: EstimateFilter): string {
  const bounds = [
    e.min !== undefined ? t('issues.filter.atLeastValue', { value: e.min }) : '',
    e.max !== undefined ? t('issues.filter.atMostValue', { value: e.max }) : '',
  ]
    .filter(Boolean)
    .join(', ');
  if (!bounds) return e.none ? t('issues.filter.estimateNone') : t('issues.filter.estimateAny');
  return e.none ? t('issues.filter.noneOr', { range: bounds }) : bounds;
}

const listValues = (c: IssueConditions | undefined, key: ListKey | FieldKey): string[] =>
  ((conditionValue(c, key) as (string | number)[] | undefined) ?? []).map(String);

/** Built-in lists and custom fields: both pick values from a list. */
const isPickKey = (k: ConditionKey): k is ListKey | FieldKey => isListKey(k) || isFieldKey(k);

const toList = (def: FilterDef, values: string[]) => (def.numeric ? values.map(Number) : values);

export function hasUserFilters(f: IssueFilter) {
  return hasConditions(f);
}

/** Picks a condition and its values for the top level (`group` undefined) or an "or" group. */
function ConditionPicker({
  filter,
  onChange,
  teamId,
  group,
  trigger,
  allowGroups,
}: {
  filter: IssueFilter;
  onChange: (f: IssueFilter) => void;
  teamId?: string;
  group?: number;
  trigger: ReactNode;
  allowGroups?: boolean;
}) {
  const ws = useWorkspace();
  const [kindKey, setKindKey] = useState<ConditionKey | null>(null);
  // Set when "Add an or group" was chosen: what's picked next starts a new group there.
  const [newGroup, setNewGroup] = useState<number | null>(null);
  const target = group ?? newGroup;
  const conds: IssueConditions = target === null ? filter : (filter.or?.[target] ?? {});
  const write = (next: IssueConditions) =>
    onChange(target === null ? (next as IssueFilter) : setGroup(filter, target, next));
  const defs = filterDefs(ws, teamId);
  const kind = defs.find((d) => d.key === kindKey) ?? null;
  const reset = () => {
    setKindKey(null);
    setNewGroup(null);
  };
  return (
    <Popover width={260} onOpenChange={(o) => !o && reset()} trigger={trigger}>
      {(close) => {
        if (kind && isPickKey(kind.key)) {
          const key = kind.key;
          return (
            <OptionList
              multi
              placeholder={t('issues.filter.search', { filter: kind.label() })}
              options={kind.options!(ws, teamId)}
              selected={listValues(conds, key)}
              onSelect={(v) => {
                const cur = listValues(conds, key);
                const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
                write(setCondition(conds, key, toList(kind, next)));
              }}
              onClose={close}
            />
          );
        }
        if (kind && isDateKey(kind.key)) {
          const key = kind.key;
          return (
            <DateEditor
              value={conds[key]}
              dueDate={key === 'dueDate'}
              onChange={(d) => write(setCondition(conds, key, d))}
              onClose={close}
            />
          );
        }
        if (kind?.key === 'estimate')
          return (
            <EstimateEditor
              value={conds.estimate}
              onChange={(e) => write(setCondition(conds, 'estimate', e))}
            />
          );
        return (
          <OptionList
            placeholder={t('issues.filter.filterBy')}
            options={[
              ...defs.map((d) => ({
                value: d.key,
                label: d.label(),
                hint: isFlagKey(d.key) ? undefined : <ChevronRight size={12} />,
              })),
              ...(allowGroups && newGroup === null
                ? [
                    {
                      value: '__group',
                      label: t('issues.filter.addGroup'),
                      icon: <Plus size={12} />,
                    },
                  ]
                : []),
            ]}
            onSelect={(v) => {
              if (v === '__group') return setNewGroup(filter.or?.length ?? 0);
              const def = defs.find((d) => d.key === v);
              if (!def) return;
              if (isFlagKey(def.key)) {
                write(setCondition(conds, def.key, true));
                close();
              } else setKindKey(def.key);
            }}
          />
        );
      }}
    </Popover>
  );
}

function DateEditor({
  value,
  dueDate,
  onChange,
  onClose,
}: {
  value: DateFilter | undefined;
  dueDate: boolean;
  onChange: (d: DateFilter | undefined) => void;
  onClose: () => void;
}) {
  const ranges = DATE_RANGES.filter((r) => dueDate || (r !== 'overdue' && r !== 'next14Days'));
  const set = (patch: Partial<DateFilter>) => {
    const next = { ...value, ...patch };
    for (const k of ['range', 'from', 'to'] as const) if (!next[k]) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div>
      <OptionList
        options={ranges.map((r) => ({ value: r, label: rangeLabel(r) }))}
        selected={value?.range ? [value.range] : []}
        onSelect={(r) => {
          set({ range: r === value?.range ? undefined : (r as DateFilter['range']) });
          onClose();
        }}
      />
      <div className="grid grid-cols-2 gap-2 border-t border-border-soft p-2">
        <label className="block text-[11px] text-muted">
          {t('issues.filter.from')}
          <input
            type="date"
            className="input mt-1"
            value={value?.from ?? ''}
            onChange={(e) => set({ from: e.target.value || undefined })}
          />
        </label>
        <label className="block text-[11px] text-muted">
          {t('issues.filter.to')}
          <input
            type="date"
            className="input mt-1"
            value={value?.to ?? ''}
            onChange={(e) => set({ to: e.target.value || undefined })}
          />
        </label>
      </div>
    </div>
  );
}

function EstimateEditor({
  value,
  onChange,
}: {
  value: EstimateFilter | undefined;
  onChange: (e: EstimateFilter | undefined) => void;
}) {
  const num = (s: string) => (s === '' ? undefined : Math.max(0, Math.floor(Number(s))));
  const setBound = (k: 'min' | 'max', s: string) => {
    const next: EstimateFilter = { ...value, [k]: num(s) };
    if (next[k] === undefined) delete next[k];
    onChange(next);
  };
  return (
    <div>
      <OptionList
        options={[
          { value: 'none', label: t('issues.filter.estimateNone') },
          { value: 'any', label: t('issues.filter.estimateAny') },
        ]}
        selected={
          value && value.min === undefined && value.max === undefined
            ? [value.none ? 'none' : 'any']
            : []
        }
        onSelect={(v) => onChange(v === 'none' ? { none: true } : {})}
      />
      <div className="grid grid-cols-2 gap-2 border-t border-border-soft p-2">
        <label className="block text-[11px] text-muted">
          {t('issues.filter.atLeast')}
          <input
            type="number"
            min={0}
            className="input mt-1"
            value={value?.min ?? ''}
            onChange={(e) => setBound('min', e.target.value)}
          />
        </label>
        <label className="block text-[11px] text-muted">
          {t('issues.filter.atMost')}
          <input
            type="number"
            min={0}
            className="input mt-1"
            value={value?.max ?? ''}
            onChange={(e) => setBound('max', e.target.value)}
          />
        </label>
      </div>
    </div>
  );
}

/** "Filter" button: adds conditions, or starts an "or" group. */
export function FilterButton({
  filter,
  onChange,
  teamId,
}: {
  filter: IssueFilter;
  onChange: (f: IssueFilter) => void;
  teamId?: string;
}) {
  return (
    <ConditionPicker
      filter={filter}
      onChange={onChange}
      teamId={teamId}
      allowGroups
      trigger={
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t('issues.filter.button')}
        >
          <Filter size={13} />
          <span className="hidden sm:inline">{t('issues.filter.button')}</span>
        </button>
      }
    />
  );
}

const chipClass = 'flex h-6 items-stretch text-[12px] shadow-[inset_0_0_0_1px_var(--color-border)]';
const segClass = 'flex items-center border-l border-border px-2';

/** One condition: label, "is"/"is not" (click to switch), its value, and a remove button. */
function Chip({
  conds,
  condKey,
  negated,
  onChange,
  teamId,
}: {
  conds: IssueConditions;
  condKey: ConditionKey;
  negated: boolean;
  onChange: (c: IssueConditions) => void;
  teamId?: string;
}) {
  const ws = useWorkspace();
  const def = defOf(ws, condKey, teamId);
  const name = def.label();
  const own = negated ? (conds.exclude ?? {}) : conds;
  const put = (value: Parameters<typeof setCondition>[2]) =>
    onChange(negated ? setExcluded(conds, condKey, value) : setCondition(conds, condKey, value));
  // A date, estimate or flag set on both sides can't switch without losing one of them.
  const canToggle = canToggleNegation(conds, condKey, negated);
  const toggle = () => onChange(toggleNegation(conds, condKey, negated));
  const remove = (
    <button
      type="button"
      className="flex flex-none items-center border-l border-border px-1.5 text-index hover:text-text"
      onClick={() => put(undefined)}
      aria-label={t('issues.filter.remove', { filter: name })}
    >
      <X size={12} />
    </button>
  );

  if (isFlagKey(condKey)) {
    // Flags read as one phrase ("Blocked", "Not blocked"); "is not" in `exclude` reads the same.
    const on = !!own[condKey] !== negated;
    return (
      <span className={chipClass}>
        <button
          type="button"
          className="flex items-center px-2 enabled:hover:bg-text/5"
          onClick={toggle}
          disabled={!canToggle}
          title={t('issues.filter.toggleNegation')}
        >
          {t(FLAG_LABELS[condKey][on ? 0 : 1])}
        </button>
        {remove}
      </span>
    );
  }

  let label: string;
  let editor: (close: () => void) => ReactNode;
  let many = false;
  if (isPickKey(condKey)) {
    const values = listValues(own, condKey);
    many = values.length > 1;
    label = values
      .map((v) => (isListKey(condKey) ? listLabel(ws, condKey, v) : def.valueLabel!(ws, v)))
      .join(', ');
    editor = (close) => (
      <OptionList
        multi
        options={def.options!(ws, teamId)}
        selected={values}
        onSelect={(v) =>
          put(toList(def, values.includes(v) ? values.filter((x) => x !== v) : [...values, v]))
        }
        onClose={close}
      />
    );
  } else if (isDateKey(condKey)) {
    const d = own[condKey];
    label = dateLabel(d ?? {});
    editor = (close) => (
      <DateEditor value={d} dueDate={condKey === 'dueDate'} onChange={put} onClose={close} />
    );
  } else {
    label = estimateLabel(own.estimate ?? {});
    editor = () => <EstimateEditor value={own.estimate} onChange={put} />;
  }
  const op = negated
    ? many
      ? t('issues.filter.isNoneOf')
      : t('issues.filter.isNot')
    : many
      ? t('issues.filter.isAnyOf')
      : t('issues.filter.is');
  return (
    <span className={`${chipClass} max-w-full`}>
      <span className="flex min-w-0 items-center px-2 text-muted">
        <span className="truncate">{name}</span>
      </span>
      <button
        type="button"
        className={`${segClass} flex-none enabled:hover:bg-text/5 ${negated ? 'text-primary' : 'text-index'}`}
        onClick={toggle}
        disabled={!canToggle}
        title={t('issues.filter.toggleNegation')}
      >
        {op}
      </button>
      <Popover
        width={260}
        trigger={
          <button type="button" className={`${segClass} min-w-0 max-w-56 hover:bg-text/5`}>
            <span className="truncate">{label}</span>
          </button>
        }
      >
        {editor}
      </Popover>
      {remove}
    </span>
  );
}

/** The chips of one set of conditions: what must hold, then what must not. */
function ConditionChips({
  conds,
  onChange,
  teamId,
}: {
  conds: IssueConditions;
  onChange: (c: IssueConditions) => void;
  teamId?: string;
}) {
  return (
    <>
      {activeKeys(conds).map((k) => (
        <Chip
          key={k}
          conds={conds}
          condKey={k}
          negated={false}
          onChange={onChange}
          teamId={teamId}
        />
      ))}
      {activeKeys(conds.exclude).map((k) => (
        <Chip
          key={`not-${k}`}
          conds={conds}
          condKey={k}
          negated
          onChange={onChange}
          teamId={teamId}
        />
      ))}
    </>
  );
}

export function FilterChips({
  filter,
  onChange,
  teamId,
}: {
  filter: IssueFilter;
  onChange: (f: IssueFilter) => void;
  teamId?: string;
}) {
  if (!hasConditions(filter)) return null;
  const groups = filter.or ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border-soft px-4 py-2">
      <ConditionChips conds={filter} onChange={(c) => onChange(c as IssueFilter)} teamId={teamId} />
      {groups.length > 0 && (
        <span className="kicker ml-1 text-index">{t('issues.filter.anyOf')}</span>
      )}
      {groups.map((g, i) => (
        <span key={i} className="flex flex-wrap items-center gap-1.5">
          {i > 0 && (
            <span className="font-mono text-[11px] text-index uppercase">
              {t('issues.filter.or')}
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1.5 border border-dashed border-border px-1.5 py-1">
            <ConditionChips
              conds={g}
              onChange={(next) => onChange(setGroup(filter, i, next))}
              teamId={teamId}
            />
            <ConditionPicker
              filter={filter}
              onChange={onChange}
              teamId={teamId}
              group={i}
              trigger={
                <button
                  type="button"
                  className="flex h-6 items-center px-1 text-index hover:text-text"
                  aria-label={t('issues.filter.addToGroup')}
                  title={t('issues.filter.addToGroup')}
                >
                  <Plus size={12} />
                </button>
              }
            />
          </span>
        </span>
      ))}
      <button
        type="button"
        className="ml-1 font-mono text-[11px] text-index uppercase tracking-[0.1em] hover:text-text"
        onClick={() => onChange({})}
      >
        {t('common.clear')}
      </button>
    </div>
  );
}
