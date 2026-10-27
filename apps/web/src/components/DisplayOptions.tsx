import { GROUP_BY_OPTIONS, type IssueDisplay, ORDER_BY_OPTIONS } from '@ordo/shared';
import { Kanban, List, SlidersHorizontal } from 'lucide-react';
import { Popover } from './ui/Popover.tsx';

const GROUP_LABELS: Record<string, string> = {
  state: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  project: 'Project',
  milestone: 'Milestone',
  cycle: 'Cycle',
  label: 'Label',
  none: 'No grouping',
};
const ORDER_LABELS: Record<string, string> = {
  manual: 'Manual',
  priority: 'Priority',
  updatedAt: 'Last updated',
  createdAt: 'Created',
  dueDate: 'Due date',
  title: 'Title',
};

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
        className="h-7 border border-border bg-bg px-2 text-[12.5px] text-text outline-none focus:border-primary"
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
          aria-label={`${l} layout`}
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
}: {
  display: IssueDisplay;
  onChange: (d: IssueDisplay) => void;
}) {
  return (
    <Popover
      width={280}
      placement="bottom-end"
      trigger={
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Display options">
          <SlidersHorizontal size={13} />
          <span className="hidden sm:inline">Display</span>
        </button>
      }
    >
      <div className="p-3">
        <div className="section-label mb-2">Display</div>
        <Select
          label="Grouping"
          value={display.groupBy}
          options={GROUP_BY_OPTIONS}
          labels={GROUP_LABELS}
          onChange={(v) => onChange({ ...display, groupBy: v as IssueDisplay['groupBy'] })}
        />
        <Select
          label="Ordering"
          value={display.orderBy}
          options={ORDER_BY_OPTIONS}
          labels={ORDER_LABELS}
          onChange={(v) => onChange({ ...display, orderBy: v as IssueDisplay['orderBy'] })}
        />
        <div className="my-2 h-px bg-border-soft" />
        <Toggle
          label="Show completed issues"
          checked={display.showCompleted}
          onChange={(v) => onChange({ ...display, showCompleted: v })}
        />
        <Toggle
          label="Show sub-issues"
          checked={display.showSubIssues}
          onChange={(v) => onChange({ ...display, showSubIssues: v })}
        />
        <Toggle
          label="Show empty groups"
          checked={display.showEmptyGroups}
          onChange={(v) => onChange({ ...display, showEmptyGroups: v })}
        />
      </div>
    </Popover>
  );
}
