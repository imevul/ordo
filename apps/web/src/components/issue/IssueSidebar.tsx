import { fieldsForTeam, type IssueDetail, type Team, type UpdateIssueInput } from '@ordo/shared';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useMoveIssues } from '../../api/queries.ts';
import { t, tx } from '../../i18n/index.ts';
import { longDate, relativeTime, slaState } from '../../lib/format.ts';
import { isDone } from '../../lib/issues.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { IssuePullRequests } from '../IssuePullRequests.tsx';
import { IssueSearchPicker } from '../IssueSearchPicker.tsx';
import { TeamIcon } from '../icons.tsx';
import {
  AssigneeProp,
  CustomFieldProp,
  CycleProp,
  DueDateProp,
  EstimateProp,
  LabelsProp,
  MilestoneProp,
  Picker,
  PriorityProp,
  ProjectProp,
  ReleaseProp,
  releaseOptions,
  StatusProp,
  teamOptions,
} from '../properties.tsx';
import { ActorName } from '../ui/ActorName.tsx';

/** The dim "> created" style keyword in the issue's metadata lines. */
const k = (s: ReactNode) => <span className="text-muted">{s}</span>;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-center gap-2 py-0.5">
      <span className="truncate text-[12px] text-index" title={label}>
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The editable properties. The sidebar shows them on wide screens and IssueDetailView shows them
 * under the title on narrow ones, so both use the same pickers.
 */
export function IssueProperties({
  issue,
  team,
  onPatch,
}: {
  issue: IssueDetail;
  team: Team | undefined;
  onPatch: (p: UpdateIssueInput) => void;
}) {
  const ws = useWorkspace();
  const sla = slaState(issue, isDone(ws, issue));

  const move = useMoveIssues(ws.slug);
  const moveToTeam = (teamId: string) => {
    if (teamId === issue.teamId) return;
    move.mutate(
      { ids: [issue.id], teamId },
      {
        // The issue page follows the new identifier itself once the issue has it (IssuePage):
        // a queued move (offline, or sent by another tab) gets its number later.
        onSuccess: (result) => {
          const moved = result?.[0];
          if (moved) toast.success(t('issue.detail.movedTo', { identifier: moved.identifier }));
          else
            toast.success(
              t('issue.detail.movedToTeam', { team: ws.teamById.get(teamId)?.name ?? '' }),
            );
        },
      },
    );
  };

  return (
    <>
      <Field label={t('common.status')}>
        <StatusProp issue={issue} onPatch={onPatch} variant="field" />
      </Field>
      <Field label={t('common.priority')}>
        <PriorityProp issue={issue} onPatch={onPatch} variant="field" />
      </Field>
      <Field label={t('common.assignee')}>
        <AssigneeProp issue={issue} onPatch={onPatch} variant="field" />
      </Field>
      {sla && (
        <Field label="SLA">
          <span
            className={`px-2 font-mono text-[12px] ${sla.state === 'breached' ? 'text-error' : sla.state === 'risk' ? 'text-warning' : 'text-muted'}`}
            title={new Date(issue.slaBreachesAt!).toLocaleString()}
          >
            {t(sla.state === 'breached' ? 'issue.detail.slaBreached' : 'issue.detail.slaLeft', {
              time: sla.span,
            })}
          </span>
        </Field>
      )}
      <Field label={t('common.labels')}>
        <LabelsProp issue={issue} onPatch={onPatch} variant="field" />
      </Field>
      <Field label={t('common.project')}>
        <ProjectProp issue={issue} onPatch={onPatch} variant="field" />
      </Field>
      {issue.projectId && !!ws.projectById.get(issue.projectId)?.milestones.length && (
        <Field label={t('common.milestone')}>
          <MilestoneProp issue={issue} onPatch={onPatch} variant="field" />
        </Field>
      )}
      {team?.cyclesEnabled && (
        <Field label={t('common.cycle')}>
          <CycleProp issue={issue} onPatch={onPatch} variant="field" />
        </Field>
      )}
      {(issue.releaseId || releaseOptions(ws, issue.teamId).length > 1) && (
        <Field label={t('common.release')}>
          <ReleaseProp issue={issue} onPatch={onPatch} variant="field" />
        </Field>
      )}
      {team && team.estimateScale !== 'none' && (
        <Field label={t('common.estimate')}>
          <EstimateProp issue={issue} onPatch={onPatch} variant="field" />
        </Field>
      )}
      <Field label={t('common.dueDate')}>
        <DueDateProp
          issue={issue}
          onPatch={onPatch}
          variant="field"
          done={!!issue.completedAt || !!issue.canceledAt}
        />
      </Field>
      {fieldsForTeam(ws.customFields, issue.teamId).map((field) => (
        <Field key={field.id} label={field.name}>
          <CustomFieldProp field={field} issue={issue} onPatch={onPatch} />
        </Field>
      ))}
      <Field label={t('common.team')}>
        <Picker
          placeholder={t('issue.detail.moveToTeam')}
          options={teamOptions(ws)}
          selected={[issue.teamId]}
          onSelect={moveToTeam}
          trigger={
            <button
              type="button"
              className="prop w-full justify-start bg-transparent shadow-none hover:bg-text/[0.03]"
            >
              {team ? (
                <>
                  <TeamIcon color={team.color} label={team.key} size={14} />
                  {team.name}
                </>
              ) : (
                <span className="text-index" title={t('issue.detail.teamUnavailableTitle')}>
                  {t('issue.detail.teamUnavailable')}
                </span>
              )}
            </button>
          }
        />
      </Field>
      <Field label={t('common.parent')}>
        <div className="flex items-center gap-1">
          <IssueSearchPicker
            exclude={[issue.id, ...issue.subIssues.map((s) => s.id)]}
            onPick={(parent) => onPatch({ parentId: parent.id })}
            trigger={
              <button
                type="button"
                className="prop min-w-0 flex-1 justify-start bg-transparent shadow-none hover:bg-text/[0.03]"
              >
                <span className="truncate">
                  {issue.parent ? issue.parent.identifier : t('issue.detail.setParent')}
                </span>
              </button>
            }
          />
          {issue.parent && (
            <button
              type="button"
              className="flex h-6 w-6 flex-none items-center justify-center text-index hover:text-text"
              onClick={() => onPatch({ parentId: null })}
              aria-label={t('issue.detail.removeParent')}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </Field>
    </>
  );
}

/** The properties sidebar on wide screens. */
export function IssueSidebar({
  issue,
  team,
  onPatch,
}: {
  issue: IssueDetail;
  team: Team | undefined;
  onPatch: (p: UpdateIssueInput) => void;
}) {
  const ws = useWorkspace();
  const creator = issue.creatorId ? ws.memberById.get(issue.creatorId) : undefined;

  return (
    <aside className="hidden w-72 flex-none overflow-y-auto border-l border-border-soft bg-surface/40 p-4 lg:block">
      <div className="section-label mb-3">{t('issue.detail.properties')}</div>
      <IssueProperties issue={issue} team={team} onPatch={onPatch} />

      <IssuePullRequests issue={issue} className="mt-6" />

      <div className="mt-6 border-t border-border-soft pt-4 font-mono text-[11px] leading-6 text-index">
        <div>
          {creator
            ? tx('issue.detail.createdBy', {
                k,
                time: relativeTime(issue.createdAt),
                name: <ActorName person={creator} className="" />,
              })
            : tx('issue.detail.created', { k, time: relativeTime(issue.createdAt) })}
        </div>
        <div title={longDate(issue.updatedAt)}>
          {tx('issue.detail.updated', { k, time: relativeTime(issue.updatedAt) })}
        </div>
        {issue.completedAt && (
          <div>{tx('issue.detail.completed', { k, time: relativeTime(issue.completedAt) })}</div>
        )}
        <div>{tx('issue.detail.subscribers', { k, count: issue.subscriberIds.length })}</div>
      </div>
    </aside>
  );
}
