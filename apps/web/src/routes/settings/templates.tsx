import { type IssueTemplate, priorityLabel } from '@ordo/shared';
import { Hexagon, Pencil, Plus, Tag, Trash2, User } from 'lucide-react';
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
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';

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
    <Modal open onClose={onClose} width={680} label={template ? 'Edit template' : 'New template'}>
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
            {template ? 'Edit template' : 'New template'}
          </span>
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2 px-4 pt-3">
          <input
            autoFocus
            className="input"
            placeholder="Template name, e.g. Bug report"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <select
            className="input w-40"
            value={draft.teamId ?? ''}
            disabled={!!template}
            title={template ? "A template's team can't change" : undefined}
            onChange={(e) =>
              // Status, estimate and team labels belong to one team.
              set({
                teamId: e.target.value || null,
                stateId: null,
                estimate: null,
                labelIds: draft.labelIds.filter((id) => !ws.labelById.get(id)?.teamId),
              })
            }
            aria-label="Team"
          >
            <option value="">All teams</option>
            {ws.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-h-0 overflow-y-auto px-4">
          <input
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Issue title (optional)"
            className="mt-4 w-full bg-transparent text-[18px] font-semibold tracking-[-0.01em] outline-none placeholder:text-index"
          />
          <MarkdownEditor
            bare
            value={draft.description}
            onChange={(description) => set({ description })}
            placeholder="Description the issue starts with…"
            minRows={5}
            className="mt-1 -mx-3"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          {teamId && (
            <Picker
              placeholder="Status…"
              options={[unset('Team default'), ...statusOptions(ws, teamId)]}
              selected={[draft.stateId ?? 'none']}
              onSelect={(v) => set({ stateId: nullable(v) })}
              trigger={chip(
                state ? <StatusIcon type={state.type} color={state.color} /> : null,
                state ? state.name : 'Status',
              )}
            />
          )}
          <Picker
            placeholder="Priority…"
            options={[unset('Not set'), ...priorityOptions()]}
            selected={[draft.priority == null ? 'none' : String(draft.priority)]}
            onSelect={(v) => set({ priority: v === 'none' ? null : Number(v) })}
            width={220}
            trigger={chip(
              draft.priority != null ? <PriorityIcon priority={draft.priority} /> : null,
              draft.priority != null ? priorityLabel(draft.priority) : 'Priority',
            )}
          />
          <Picker
            placeholder="Assign to…"
            options={assigneeOptions(ws)}
            selected={[draft.assigneeId ?? 'none']}
            onSelect={(v) => set({ assigneeId: nullable(v) })}
            trigger={chip(<User size={14} />, assignee?.name ?? 'Assignee')}
          />
          <Picker
            multi
            placeholder="Labels…"
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
              labels.length ? labels.map((l) => l.name).join(', ') : 'Labels',
            )}
          />
          <Picker
            placeholder="Project…"
            options={projectOptions(ws, teamId)}
            selected={[draft.projectId ?? 'none']}
            onSelect={(v) => set({ projectId: nullable(v) })}
            trigger={chip(<Hexagon size={14} />, project?.name ?? 'Project')}
          />
          {estimates.length > 0 && (
            <Picker
              placeholder="Estimate…"
              options={estimates}
              selected={[draft.estimate == null ? 'none' : String(draft.estimate)]}
              onSelect={(v) => set({ estimate: v === 'none' ? null : Number(v) })}
              width={200}
              trigger={chip(
                <span className="font-mono text-[11px]">◇</span>,
                estimates.find((o) => o.value === String(draft.estimate))?.label ?? 'Estimate',
              )}
            />
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border-soft px-4 py-3">
          <span className="font-mono text-[11px] text-index">
            // properties left unset keep the new issue's own
          </span>
          <button type="button" className="btn btn-ghost ml-auto" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!draft.name.trim() || save.isPending}>
            {template ? 'Save' : 'Create template'} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TemplateRow({ template, onEdit }: { template: IssueTemplate; onEdit: () => void }) {
  const ws = useWorkspace();
  const remove = useWsMutation(ws.slug, () =>
    api.del(wsPath(ws.slug, `/templates/${template.id}`)),
  );
  const team = template.teamId ? ws.teamById.get(template.teamId) : null;
  return (
    <div className="flex h-11 items-center gap-3 border-b border-border-soft">
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
      <span className="tag font-mono">{team ? team.key : 'all teams'}</span>
      {!ws.isGuest && (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onEdit}
            aria-label={`Edit ${template.name}`}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={async () => {
              if (
                await confirmDialog({ title: `Delete template “${template.name}”?`, danger: true })
              )
                remove.mutate(undefined);
            }}
            aria-label={`Delete ${template.name}`}
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
    <SettingsCard
      title="Issue templates"
      description="Starting points for new issues: a title, a description and default properties. Pick one under Template when creating an issue. Templates for all teams appear everywhere; team templates only in their team."
    >
      {!ws.isGuest && (
        <button type="button" className="btn btn-primary mb-5" onClick={() => setEditing('new')}>
          <Plus size={13} /> New template
        </button>
      )}
      {ws.templates.map((t) => (
        <TemplateRow key={t.id} template={t} onEdit={() => !ws.isGuest && setEditing(t)} />
      ))}
      {ws.templates.length === 0 && (
        <p className="font-mono text-[12px] text-index">// no templates yet</p>
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
