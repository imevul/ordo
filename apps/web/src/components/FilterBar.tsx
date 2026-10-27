import { type IssueFilter, STATE_TYPES, type StateType } from '@ordo/shared';
import { ChevronRight, Filter, X } from 'lucide-react';
import { useState } from 'react';
import { type MessageKey, t } from '../i18n/index.ts';
import { priorityLabel, priorityOptions, stateTypeLabel } from '../i18n/labels.ts';
import { cycleName, useWorkspace, type WorkspaceData } from '../lib/workspace.tsx';
import { PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';
import { labelOptions, statusOptions } from './properties.tsx';
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

interface FilterDef {
  key: FilterKey;
  /** A message key: labels are looked up at render time, after the catalogue has loaded. */
  label: MessageKey;
  options: (ws: WorkspaceData, teamId?: string) => Option[];
  numeric?: boolean;
}

const memberOptions = (ws: WorkspaceData, withNone: boolean): Option[] => [
  {
    value: 'me',
    label: t('issues.filter.me'),
    icon: <Avatar name={ws.me.name} color={ws.me.avatarColor} src={ws.me.avatarUrl} size={16} />,
  },
  ...(withNone
    ? [{ value: 'none', label: t('issues.none.assignee'), icon: <EmptyAvatar size={16} /> }]
    : []),
  ...ws.members
    .filter((m) => m.id !== ws.me.id)
    .map((m) => ({
      value: m.id,
      label: m.name,
      icon: <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={16} />,
    })),
];

const DEFS: FilterDef[] = [
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
    options: (ws) => memberOptions(ws, true),
  },
  { key: 'creatorIds', label: 'common.creator', options: (ws) => memberOptions(ws, false) },
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
];

function valueLabel(ws: WorkspaceData, key: FilterKey, v: string): string {
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
    case 'cycleIds': {
      if (v === 'none') return t('issues.none.cycle');
      const c = ws.cycleById.get(v);
      return c ? cycleName(c) : '?';
    }
  }
}

function getValues(filter: IssueFilter, key: FilterKey): string[] {
  return ((filter[key] as (string | number)[] | undefined) ?? []).map(String);
}

function setValues(filter: IssueFilter, def: FilterDef, values: string[]): IssueFilter {
  const next = { ...filter } as Record<string, unknown>;
  if (values.length === 0) delete next[def.key];
  else next[def.key] = def.numeric ? values.map(Number) : values;
  return next as IssueFilter;
}

export function hasUserFilters(f: IssueFilter) {
  return DEFS.some((d) => getValues(f, d.key).length > 0);
}

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
  const [kind, setKind] = useState<FilterDef | null>(null);
  const defs = DEFS.filter((d) => (teamId ? d.key !== 'stateTypes' : d.key !== 'stateIds'));
  return (
    <Popover
      width={260}
      onOpenChange={(o) => !o && setKind(null)}
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
            placeholder={t('issues.filter.search', { filter: t(kind.label) })}
            options={kind.options(ws, teamId)}
            selected={getValues(filter, kind.key)}
            onSelect={(v) => {
              const cur = getValues(filter, kind.key);
              onChange(
                setValues(filter, kind, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]),
              );
            }}
            onClose={close}
          />
        ) : (
          <OptionList
            placeholder={t('issues.filter.filterBy')}
            options={defs.map((d) => ({
              value: d.key,
              label: t(d.label),
              hint: <ChevronRight size={12} />,
            }))}
            onSelect={(v) => setKind(defs.find((d) => d.key === v) ?? null)}
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
  const active = DEFS.filter((d) => getValues(filter, d.key).length > 0);
  if (active.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border-soft px-4 py-2">
      {active.map((d) => {
        const values = getValues(filter, d.key);
        return (
          <span
            key={d.key}
            className="flex h-6 items-stretch text-[12px] shadow-[inset_0_0_0_1px_var(--color-border)]"
          >
            <span className="flex items-center px-2 text-muted">{t(d.label)}</span>
            <span className="flex items-center border-l border-border px-2 text-index">
              {values.length > 1 ? t('issues.filter.isAnyOf') : t('issues.filter.is')}
            </span>
            <Popover
              width={260}
              trigger={
                <button
                  type="button"
                  className="flex max-w-56 items-center border-l border-border px-2 hover:bg-text/5"
                >
                  <span className="truncate">
                    {values.map((v) => valueLabel(ws, d.key, v)).join(', ')}
                  </span>
                </button>
              }
            >
              {(close) => (
                <OptionList
                  multi
                  options={d.options(ws, teamId)}
                  selected={values}
                  onSelect={(v) =>
                    onChange(
                      setValues(
                        filter,
                        d,
                        values.includes(v) ? values.filter((x) => x !== v) : [...values, v],
                      ),
                    )
                  }
                  onClose={close}
                />
              )}
            </Popover>
            <button
              type="button"
              className="flex items-center border-l border-border px-1.5 text-index hover:text-text"
              onClick={() => onChange(setValues(filter, d, []))}
              aria-label={t('issues.filter.remove', { filter: t(d.label) })}
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
