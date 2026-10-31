import { type CustomField, type IssueFilter, STATE_TYPES, type StateType } from '@ordo/shared';
import { ChevronRight, Filter, X } from 'lucide-react';
import { useState } from 'react';
import { type MessageKey, t } from '../i18n/index.ts';
import { priorityLabel, priorityOptions, stateTypeLabel } from '../i18n/labels.ts';
import { fieldLabel, fieldsInScope, hasChoices, optionName } from '../lib/customFields.ts';
import { cycleName, useWorkspace, type WorkspaceData } from '../lib/workspace.tsx';
import { PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';
import { fieldOptionChoices, labelOptions, statusOptions } from './properties.tsx';
import { Avatar, EmptyAvatar } from './ui/Avatar.tsx';
import { type Option, OptionList } from './ui/OptionList.tsx';
import { Popover } from './ui/Popover.tsx';

type FilterKey =
  | 'stateIds'
  | 'stateTypes'
  | 'priorities'
  | 'assigneeIds'
  | 'creatorIds'
  | 'labelIds'
  | 'projectIds'
  | 'cycleIds';

/** One filter: a built-in property or a custom field. */
interface FilterDef {
  id: string;
  /** Read at render time, after the catalogue has loaded. */
  label: () => string;
  options: (ws: WorkspaceData, teamId?: string) => Option[];
  get: (filter: IssueFilter) => string[];
  set: (filter: IssueFilter, values: string[]) => IssueFilter;
  valueLabel: (ws: WorkspaceData, value: string) => string;
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

const personLabel = (ws: WorkspaceData, v: string, none: string) =>
  v === 'me' ? t('issues.filter.me') : v === 'none' ? none : (ws.memberById.get(v)?.name ?? '?');

/** A filter on one of IssueFilter's own lists. */
function builtin(
  key: FilterKey,
  label: MessageKey,
  options: FilterDef['options'],
  valueLabel: FilterDef['valueLabel'],
  numeric = false,
): FilterDef {
  return {
    id: key,
    label: () => t(label),
    options,
    valueLabel,
    get: (f) => ((f[key] as (string | number)[] | undefined) ?? []).map(String),
    set: (f, values) => {
      const next = { ...f } as Record<string, unknown>;
      if (values.length === 0) delete next[key];
      else next[key] = numeric ? values.map(Number) : values;
      return next as IssueFilter;
    },
  };
}

const BUILTIN: FilterDef[] = [
  builtin(
    'stateIds',
    'common.status',
    (ws, teamId) => (teamId ? statusOptions(ws, teamId) : []),
    (ws, v) => ws.stateById.get(v)?.name ?? '?',
  ),
  builtin(
    'stateTypes',
    'issues.filter.statusType',
    () =>
      STATE_TYPES.map((type) => ({
        value: type,
        label: stateTypeLabel(type),
        icon: <StatusIcon type={type} color="var(--color-muted)" />,
      })),
    (_, v) => (STATE_TYPES.includes(v as StateType) ? stateTypeLabel(v as StateType) : v),
  ),
  builtin(
    'priorities',
    'common.priority',
    () =>
      priorityOptions().map((p) => ({
        value: String(p.value),
        label: p.label,
        icon: <PriorityIcon priority={p.value} />,
      })),
    (_, v) => priorityLabel(Number(v)),
    true,
  ),
  builtin(
    'assigneeIds',
    'common.assignee',
    (ws) => memberOptions(ws, t('issues.none.assignee')),
    (ws, v) => personLabel(ws, v, t('issues.filter.nobody')),
  ),
  builtin(
    'creatorIds',
    'common.creator',
    (ws) => memberOptions(ws, null),
    (ws, v) => personLabel(ws, v, t('issues.filter.nobody')),
  ),
  builtin(
    'labelIds',
    'common.labels',
    (ws, teamId) => labelOptions(ws, teamId),
    (ws, v) => ws.labelById.get(v)?.name ?? '?',
  ),
  builtin(
    'projectIds',
    'common.project',
    (ws) => [
      { value: 'none', label: t('issues.none.project') },
      ...ws.projects.map((p) => ({
        value: p.id,
        label: p.name,
        icon: <ProjectIcon color={p.color} />,
      })),
    ],
    (ws, v) => (v === 'none' ? t('issues.none.project') : (ws.projectById.get(v)?.name ?? '?')),
  ),
  builtin(
    'cycleIds',
    'common.cycle',
    (ws, teamId) => [
      { value: 'none', label: t('issues.none.cycle') },
      ...ws.cycles
        .filter((c) => !teamId || c.teamId === teamId)
        .map((c) => ({
          value: c.id,
          label: `${teamId ? '' : `${ws.teamById.get(c.teamId)?.key} · `}${cycleName(c)}`,
        })),
    ],
    (ws, v) => {
      if (v === 'none') return t('issues.none.cycle');
      const c = ws.cycleById.get(v);
      return c ? cycleName(c) : '?';
    },
  ),
];

/**
 * A filter on a custom field, kept in `filter.customFields`. `field` is missing when the filter
 * names a field that was deleted: it still shows, so it can be removed.
 */
function fieldDef(ws: WorkspaceData, id: string, field?: CustomField, teamId?: string): FilterDef {
  const name = field?.name ?? t('customFields.activity.deletedField');
  const none = t('customFields.props.none', { field: name });
  return {
    id: `field:${id}`,
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
    get: (f) => f.customFields?.[id] ?? [],
    set: (f, values) => {
      const fields = { ...f.customFields };
      if (values.length) fields[id] = values;
      else delete fields[id];
      const { customFields: _, ...rest } = f;
      return Object.keys(fields).length ? { ...rest, customFields: fields } : rest;
    },
  };
}

/** Built-in filters, then the custom fields with choices (select, multi-select, person). */
function filterDefs(ws: WorkspaceData, teamId?: string): FilterDef[] {
  return [
    ...BUILTIN.filter((d) => (teamId ? d.id !== 'stateTypes' : d.id !== 'stateIds')),
    ...fieldsInScope(ws.customFields, teamId)
      .filter(hasChoices)
      .map((f) => fieldDef(ws, f.id, f, teamId)),
  ];
}

/** The filters set in `filter`, including ones on fields since deleted or out of scope. */
function activeDefs(ws: WorkspaceData, filter: IssueFilter, teamId?: string): FilterDef[] {
  return [
    ...BUILTIN.filter((d) => d.get(filter).length > 0),
    ...Object.keys(filter.customFields ?? {})
      .filter((id) => filter.customFields![id]!.length > 0)
      .map((id) => fieldDef(ws, id, ws.customFieldById.get(id), teamId)),
  ];
}

export function hasUserFilters(f: IssueFilter) {
  return (
    BUILTIN.some((d) => d.get(f).length > 0) ||
    Object.values(f.customFields ?? {}).some((v) => v.length > 0)
  );
}

const toggle = (values: string[], v: string) =>
  values.includes(v) ? values.filter((x) => x !== v) : [...values, v];

/** "Filter" button plus removable chips for each active filter. */
export function FilterButton({
  filter,
  onChange,
  teamId,
}: {
  filter: IssueFilter;
  onChange: (f: IssueFilter) => void;
  teamId?: string;
}) {
  const ws = useWorkspace();
  const [kindId, setKindId] = useState<string | null>(null);
  const defs = filterDefs(ws, teamId);
  const kind = defs.find((d) => d.id === kindId) ?? null;
  return (
    <Popover
      width={260}
      onOpenChange={(o) => !o && setKindId(null)}
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
    >
      {(close) =>
        kind ? (
          <OptionList
            multi
            placeholder={t('issues.filter.search', { filter: kind.label() })}
            options={kind.options(ws, teamId)}
            selected={kind.get(filter)}
            onSelect={(v) => onChange(kind.set(filter, toggle(kind.get(filter), v)))}
            onClose={close}
          />
        ) : (
          <OptionList
            placeholder={t('issues.filter.filterBy')}
            options={defs.map((d) => ({
              value: d.id,
              label: d.label(),
              hint: <ChevronRight size={12} />,
            }))}
            onSelect={setKindId}
          />
        )
      }
    </Popover>
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
  const ws = useWorkspace();
  const active = activeDefs(ws, filter, teamId);
  if (active.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border-soft px-4 py-2">
      {active.map((d) => {
        const values = d.get(filter);
        const label = d.label();
        return (
          <span
            key={d.id}
            className="flex h-6 max-w-full items-stretch text-[12px] shadow-[inset_0_0_0_1px_var(--color-border)]"
          >
            <span className="flex min-w-0 items-center px-2 text-muted">
              <span className="truncate">{label}</span>
            </span>
            <span className="flex flex-none items-center border-l border-border px-2 text-index">
              {values.length > 1 ? t('issues.filter.isAnyOf') : t('issues.filter.is')}
            </span>
            <Popover
              width={260}
              trigger={
                <button
                  type="button"
                  className="flex min-w-0 max-w-56 items-center border-l border-border px-2 hover:bg-text/5"
                >
                  <span className="truncate">
                    {values.map((v) => d.valueLabel(ws, v)).join(', ')}
                  </span>
                </button>
              }
            >
              {(close) => (
                <OptionList
                  multi
                  options={d.options(ws, teamId)}
                  selected={values}
                  onSelect={(v) => onChange(d.set(filter, toggle(values, v)))}
                  onClose={close}
                />
              )}
            </Popover>
            <button
              type="button"
              className="flex flex-none items-center border-l border-border px-1.5 text-index hover:text-text"
              onClick={() => onChange(d.set(filter, []))}
              aria-label={t('issues.filter.remove', { filter: label })}
            >
              <X size={12} />
            </button>
          </span>
        );
      })}
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
