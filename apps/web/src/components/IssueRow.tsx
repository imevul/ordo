import type { Issue, UpdateIssueInput } from '@ordo/shared';
import { Link } from '@tanstack/react-router';
import { GitBranch } from 'lucide-react';
import { memo } from 'react';
import { dueState, shortDate, slaState } from '../lib/format.ts';
import { isDone } from '../lib/issues.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { ProjectIcon } from './icons.tsx';
import { AssigneeProp, PriorityProp, StatusProp } from './properties.tsx';

interface Props {
  issue: Issue;
  focused: boolean;
  selected: boolean;
  showTeam?: boolean;
  onPatch: (issue: Issue, patch: UpdateIssueInput) => void;
  onFocus: () => void;
  onToggleSelect: (shift: boolean) => void;
}

export const IssueRow = memo(function IssueRow({
  issue,
  focused,
  selected,
  onPatch,
  onFocus,
  onToggleSelect,
}: Props) {
  const ws = useWorkspace();
  const patch = (p: UpdateIssueInput) => onPatch(issue, p);
  const labels = issue.labelIds.map((id) => ws.labelById.get(id)).filter(Boolean);
  const project = issue.projectId ? ws.projectById.get(issue.projectId) : null;
  const due = dueState(issue.dueDate, isDone(ws, issue));
  const sla = slaState(issue, isDone(ws, issue));
  const team = ws.teamById.get(issue.teamId);

  return (
    <div
      className="row group flex h-10 items-center gap-2 border-b border-border-soft/60 pr-4 pl-2"
      data-focused={focused}
      data-selected={selected}
      data-issue-id={issue.id}
      onMouseEnter={onFocus}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={selected ? `Deselect ${issue.identifier}` : `Select ${issue.identifier}`}
        className={`flex h-6 w-6 flex-none items-center justify-center ${selected ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
        onClick={(e) => onToggleSelect(e.shiftKey)}
      >
        <span
          className={`h-3.5 w-3.5 border ${selected ? 'border-primary bg-primary' : 'border-border'}`}
        />
      </button>
      <PriorityProp issue={issue} onPatch={patch} variant="icon" />
      <span className="w-[4.75rem] flex-none truncate font-mono text-[11.5px] text-index">
        {issue.identifier}
      </span>
      <StatusProp issue={issue} onPatch={patch} variant="icon" />
      <Link
        to="/$slug/issue/$identifier"
        params={{ slug: ws.slug, identifier: issue.identifier }}
        className="min-w-0 flex-1 truncate text-[13.5px] text-text"
        tabIndex={-1}
      >
        {issue.title}
      </Link>
      {issue.subIssueCount > 0 && (
        <span
          className="flex flex-none items-center gap-1 font-mono text-[11px] text-index"
          title="Sub-issues"
        >
          <GitBranch size={12} />
          {issue.completedSubIssueCount}/{issue.subIssueCount}
        </span>
      )}
      <div className="hidden flex-none items-center gap-1.5 md:flex">
        {labels.slice(0, 3).map((l) => (
          <span key={l!.id} className="tag">
            <span className="tag-dot" style={{ background: l!.color }} />
            {l!.name}
          </span>
        ))}
        {labels.length > 3 && <span className="tag">+{labels.length - 3}</span>}
        {project && (
          <span className="tag max-w-40">
            <ProjectIcon color={project.color} size={11} />
            <span className="truncate">{project.name}</span>
          </span>
        )}
        {sla && (
          <span
            className={`tag font-mono ${sla.state === 'breached' ? 'text-error' : sla.state === 'risk' ? 'text-warning' : ''}`}
            title={`SLA ${sla.state === 'breached' ? 'ran out' : 'runs out'} ${new Date(issue.slaBreachesAt!).toLocaleString()}`}
          >
            {sla.label}
          </span>
        )}
        {issue.dueDate && (
          <span
            className={`tag ${due === 'overdue' ? 'text-error' : due === 'soon' ? 'text-warning' : ''}`}
          >
            {shortDate(issue.dueDate)}
          </span>
        )}
        {issue.estimate != null && team?.estimateScale !== 'none' && (
          <span className="tag font-mono">{issue.estimate}</span>
        )}
      </div>
      <span className="hidden w-14 flex-none text-right font-mono text-[11px] text-index lg:block">
        {shortDate(issue.createdAt)}
      </span>
      <AssigneeProp issue={issue} onPatch={patch} variant="icon" />
    </div>
  );
});
