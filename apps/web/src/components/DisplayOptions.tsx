import { GROUP_BY_OPTIONS, type IssueDisplay, ORDER_BY_OPTIONS } from '@ordo/shared';
import { Kanban, List, SlidersHorizontal } from 'lucide-react';
import { t } from '../i18n/index.ts';
import { fieldLabel, fieldsInScope, groupingField, hasChoices } from '../lib/customFields.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Popover } from './ui/Popover.tsx';

// Labels are looked up at render time: the catalogue loads after this module.
const groupLabels = (): Record<string, string> => ({
  state: t('common.status'),
  priority: t('common.priority'),
  assignee: t('common.assignee'),
  project: t('common.project'),
  milestone: t('common.milestone'),
  cycle: t('common.cycle'),
  label: t('common.label'),
  none: t('issues.display.noGrouping'),
});
const orderLabels = (): Record<string, string> => ({
  manual: t('issues.display.manual'),
  priority: t('common.priority'),
  updatedAt: t('issues.display.lastUpdated'),
  createdAt: t('common.created'),
  dueDate: t('common.dueDate'),
  title: t('issues.display.title'),
});

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-1.5 text-[13px] text-muted">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 flex-none transition-colors ${checked ? 'bg-primary' : 'bg-border'}`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 bg-bg transition-[left] ${checked ? 'left-3.5' : 'left-0.5'}`}
        />
      </button>
    </label>
  );
}

function Select({
  value,
  options,
  labels,
  onChange,
  label,
}: {
  value: string;
  options: readonly string[];
  labels: Record<string, string>;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-1.5 text-[13px] text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 max-w-40 border border-border bg-bg px-2 text-[12.5px] text-text outline-none focus:border-primary"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function LayoutToggle({
  display,
  onChange,
}: {
  display: IssueDisplay;
  onChange: (d: IssueDisplay) => void;
}) {
  return (
    <div className="flex h-[1.625rem] shadow-[inset_0_0_0_1px_var(--color-border)]">
      {(['list', 'board'] as const).map((l) => (
        <button
          type="button"
          key={l}
          aria-label={t(l === 'list' ? 'issues.display.listLayout' : 'issues.display.boardLayout')}
          aria-pressed={display.layout === l}
          onClick={() => onChange({ ...display, layout: l })}
          className={`flex w-8 items-center justify-center ${display.layout === l ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
        >
          {l === 'list' ? <List size={14} /> : <Kanban size={14} />}
        </button>
      ))}
    </div>
  );
}

export function DisplayOptions({
  display,
  onChange,
  teamId,
}: {
  display: IssueDisplay;
  onChange: (d: IssueDisplay) => void;
  /** The team of the screen, if one: offers its custom fields (and the workspace's) to group by. */
  teamId?: string;
}) {
  const ws = useWorkspace();
  const fields = fieldsInScope(ws.customFields, teamId).filter(hasChoices);
  const groupings: string[] = [...GROUP_BY_OPTIONS, ...fields.map((f) => `field:${f.id}`)];
  const labels = groupLabels();
  for (const f of fields) labels[`field:${f.id}`] = fieldLabel(ws, f, teamId);
  // A grouping by a field that's gone (or out of scope) still shows, until changed.
  if (!groupings.includes(display.groupBy)) {
    groupings.push(display.groupBy);
    const field = groupingField(ws, display.groupBy);
    labels[display.groupBy] = field ? fieldLabel(ws, field) : t('issues.display.noGrouping');
  }
  return (
    <Popover
      width={280}
      placement="bottom-end"
      trigger={
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t('issues.display.options')}
        >
          <SlidersHorizontal size={13} />
          <span className="hidden sm:inline">{t('issues.display.button')}</span>
        </button>
      }
    >
      <div className="p-3">
        <div className="section-label mb-2">{t('issues.display.button')}</div>
        <Select
          label={t('issues.display.grouping')}
          value={display.groupBy}
          options={groupings}
          labels={labels}
          onChange={(v) => onChange({ ...display, groupBy: v as IssueDisplay['groupBy'] })}
        />
        <Select
          label={t('issues.display.ordering')}
          value={display.orderBy}
          options={ORDER_BY_OPTIONS}
          labels={orderLabels()}
          onChange={(v) => onChange({ ...display, orderBy: v as IssueDisplay['orderBy'] })}
        />
        <div className="my-2 h-px bg-border-soft" />
        <Toggle
          label={t('issues.display.showCompleted')}
          checked={display.showCompleted}
          onChange={(v) => onChange({ ...display, showCompleted: v })}
        />
        <Toggle
          label={t('issues.display.showSubIssues')}
          checked={display.showSubIssues}
          onChange={(v) => onChange({ ...display, showSubIssues: v })}
        />
        <Toggle
          label={t('issues.display.showEmptyGroups')}
          checked={display.showEmptyGroups}
          onChange={(v) => onChange({ ...display, showEmptyGroups: v })}
        />
      </div>
    </Popover>
  );
}
