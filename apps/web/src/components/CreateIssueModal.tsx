import type { CreateIssueInput, UpdateIssueInput } from '@ordo/shared';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAttachmentUpload, useCreateIssue } from '../api/queries.ts';
import { modKey } from '../lib/hotkeys.ts';
import { ui, useUi } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { TeamIcon } from './icons.tsx';
import { MarkdownEditor } from './MarkdownEditor.tsx';
import {
  AssigneeProp,
  CycleProp,
  DueDateProp,
  EstimateProp,
  type IssueLike,
  LabelsProp,
  Picker,
  PriorityProp,
  ProjectProp,
  StatusProp,
  teamOptions,
} from './properties.tsx';
import { Modal } from './ui/Modal.tsx';

type Form = IssueLike & { title: string; description: string; parentId: string | null };

export function CreateIssueModal() {
  const defaults = useUi((s) => s.createIssue);
  const ws = useWorkspace();
  const upload = useAttachmentUpload(ws.slug);
  const navigate = useNavigate();
  const create = useCreateIssue(ws.slug);
  const [more, setMore] = useState(false);
  const [form, setForm] = useState<Form | null>(null);

  const initial = (d: Partial<CreateIssueInput>, keep?: Form): Form => {
    const team = ws.teamById.get(d.teamId ?? '') ?? ws.myTeams[0] ?? ws.teams[0]!;
    const defaultState =
      team.states.find((s) => s.id === team.defaultStateId) ??
      team.states.find((s) => s.type === 'backlog') ??
      team.states[0]!;
    return {
      title: '',
      description: '',
      teamId: team.id,
      stateId:
        d.stateId && team.states.some((s) => s.id === d.stateId)
          ? d.stateId
          : (keep?.stateId ?? defaultState.id),
      priority: d.priority ?? keep?.priority ?? 0,
      assigneeId: d.assigneeId !== undefined ? d.assigneeId : (keep?.assigneeId ?? null),
      labelIds: d.labelIds ?? keep?.labelIds ?? [],
      projectId: d.projectId !== undefined ? d.projectId : (keep?.projectId ?? null),
      cycleId: d.cycleId !== undefined ? d.cycleId : (keep?.cycleId ?? null),
      estimate: d.estimate ?? null,
      dueDate: d.dueDate ?? null,
      parentId: d.parentId ?? null,
    };
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-initialise when the modal is (re)opened
  useEffect(() => {
    setForm(defaults ? initial(defaults) : null);
  }, [defaults]);

  if (!defaults || !form) return null;
  const close = () => ui.set({ createIssue: null });
  const team = ws.teamById.get(form.teamId)!;
  const parent = form.parentId;

  const patch = (p: UpdateIssueInput) =>
    setForm((f) => {
      if (!f) return f;
      const next = { ...f } as Form & Record<string, unknown>;
      for (const [k, v] of Object.entries(p))
        if (k !== 'addLabelIds' && k !== 'removeLabelIds') next[k] = v;
      if (p.addLabelIds) next.labelIds = [...new Set([...f.labelIds, ...p.addLabelIds])];
      if (p.removeLabelIds)
        next.labelIds = f.labelIds.filter((l) => !p.removeLabelIds!.includes(l));
      return next;
    });

  const changeTeam = (teamId: string) =>
    setForm((f) =>
      f
        ? {
            ...initial({ teamId }),
            title: f.title,
            description: f.description,
            priority: f.priority,
            assigneeId: f.assigneeId,
          }
        : f,
    );

  const submit = () => {
    if (!form.title.trim()) return;
    const input: CreateIssueInput = {
      teamId: form.teamId,
      title: form.title.trim(),
      description: form.description,
      stateId: form.stateId,
      priority: form.priority,
      assigneeId: form.assigneeId,
      labelIds: form.labelIds,
      projectId: form.projectId,
      cycleId: form.cycleId,
      estimate: form.estimate,
      dueDate: form.dueDate,
      parentId: form.parentId,
    };
    create.mutate(input, {
      onSuccess: (issue) => {
        toast.success(`${issue.identifier} created`, {
          description: issue.title,
          action: {
            label: 'View',
            onClick: () =>
              navigate({
                to: '/$slug/issue/$identifier',
                params: { slug: ws.slug, identifier: issue.identifier },
              }),
          },
        });
        if (more) setForm((f) => (f ? { ...f, title: '', description: '' } : f));
        else close();
      },
    });
  };

  return (
    <Modal open onClose={close} width={720} label="New issue">
      <div
        className="flex min-h-0 flex-col"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="flex items-center gap-2 px-4 pt-3">
          <Picker
            placeholder="Move to team…"
            options={teamOptions(ws)}
            selected={[form.teamId]}
            onSelect={changeTeam}
            trigger={
              <button type="button" className="prop">
                <TeamIcon color={team.color} label={team.key} size={14} />
                <span className="font-mono text-[11px]">{team.key}</span>
              </button>
            }
          />
          <ChevronRight size={12} className="text-index" />
          <span className="kicker text-[11px] uppercase tracking-[0.14em]">
            {parent ? 'New sub-issue' : 'New issue'}
          </span>
          <button
            type="button"
            className="ml-auto flex h-7 w-7 items-center justify-center text-index hover:text-text"
            onClick={close}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4">
          <input
            autoFocus
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                (
                  e.currentTarget.parentElement?.querySelector(
                    'textarea',
                  ) as HTMLTextAreaElement | null
                )?.focus();
              }
            }}
            placeholder="Issue title"
            className="mt-3 w-full bg-transparent text-[20px] font-semibold tracking-[-0.01em] outline-none placeholder:text-index"
          />
          <MarkdownEditor
            bare
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
            onSubmit={submit}
            placeholder="Add description…"
            minRows={4}
            onUpload={upload}
            className="mt-1 -mx-3"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          <StatusProp issue={form} onPatch={patch} />
          <PriorityProp issue={form} onPatch={patch} />
          <AssigneeProp issue={form} onPatch={patch} />
          <LabelsProp issue={form} onPatch={patch} />
          <ProjectProp issue={form} onPatch={patch} />
          <CycleProp issue={form} onPatch={patch} />
          <EstimateProp issue={form} onPatch={patch} />
          <DueDateProp issue={form} onPatch={patch} />
        </div>
        <div className="flex items-center gap-3 border-t border-border-soft px-4 py-3">
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <input
              type="checkbox"
              checked={more}
              onChange={(e) => setMore(e.target.checked)}
              className="accent-primary"
            />
            Create more
          </label>
          <span className="ml-auto font-mono text-[11px] text-index">{modKey}+Enter</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!form.title.trim() || create.isPending}
          >
            Create issue <span className="arrow">→</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
