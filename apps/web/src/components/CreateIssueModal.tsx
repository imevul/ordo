import type { AiDraft, CreateIssueInput, IssueTemplate, UpdateIssueInput } from '@ordo/shared';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight, FileText, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import { useAttachmentUpload, useCreateIssue } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { modKey } from '../lib/hotkeys.ts';
import { ui, useUi } from '../lib/store.ts';
import { defaultAssigneeOf, useWorkspace } from '../lib/workspace.tsx';
import { useAiEnabled } from './AiAssist.tsx';
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

type Form = IssueLike & {
  title: string;
  description: string;
  parentId: string | null;
  /** The assignee is the default (workspace's or project's), so it follows the team and project. */
  assigneeAuto: boolean;
};

export function CreateIssueModal() {
  const defaults = useUi((s) => s.createIssue);
  const ws = useWorkspace();
  const upload = useAttachmentUpload(ws.slug);
  const navigate = useNavigate();
  const create = useCreateIssue(ws.slug);
  const [more, setMore] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const aiEnabled = useAiEnabled();
  const [drafting, setDrafting] = useState(false);

  const initial = (d: Partial<CreateIssueInput>, keep?: Form): Form => {
    const team = ws.teamById.get(d.teamId ?? '') ?? ws.myTeams[0] ?? ws.teams[0]!;
    const defaultState =
      team.states.find((s) => s.id === team.defaultStateId) ??
      team.states.find((s) => s.type === 'backlog') ??
      team.states[0]!;
    const projectId = d.projectId !== undefined ? d.projectId : (keep?.projectId ?? null);
    const explicit =
      d.assigneeId !== undefined
        ? d.assigneeId
        : keep && !keep.assigneeAuto
          ? keep.assigneeId
          : undefined;
    return {
      title: '',
      description: '',
      teamId: team.id,
      stateId:
        d.stateId && team.states.some((s) => s.id === d.stateId)
          ? d.stateId
          : (keep?.stateId ?? defaultState.id),
      priority: d.priority ?? keep?.priority ?? 0,
      assigneeId: explicit !== undefined ? explicit : defaultAssigneeOf(ws, team.id, projectId),
      assigneeAuto: explicit === undefined,
      labelIds: d.labelIds ?? keep?.labelIds ?? [],
      projectId,
      cycleId: d.cycleId !== undefined ? d.cycleId : (keep?.cycleId ?? null),
      estimate: d.estimate ?? null,
      dueDate: d.dueDate ?? null,
      parentId: d.parentId ?? null,
    };
  };

  // Only re-initialise when the modal is (re)opened.
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
      // Picking someone (or nobody) is final; until then the default follows the project.
      if (p.assigneeId !== undefined) next.assigneeAuto = false;
      else if (f.assigneeAuto && p.projectId !== undefined)
        next.assigneeId = defaultAssigneeOf(ws, f.teamId, p.projectId);
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
            ...(!f.assigneeAuto && { assigneeId: f.assigneeId, assigneeAuto: false }),
          }
        : f,
    );

  const templates = ws.templates.filter((tpl) => !tpl.teamId || ws.teamById.has(tpl.teamId));

  /**
   * Fills the form from a template: its team, the properties it sets, and its title and description
   * where you haven't written your own (a description you started gets the template's below it).
   */
  const templateProject = (tpl: IssueTemplate, base: Form) =>
    tpl.projectId && ws.projectById.has(tpl.projectId) ? tpl.projectId : base.projectId;
  // A template's assignee is a choice; without one, a default still follows the project.
  const templateAssignee = (tpl: IssueTemplate, base: Form) =>
    tpl.assigneeId && ws.memberById.has(tpl.assigneeId)
      ? { assigneeId: tpl.assigneeId, assigneeAuto: false }
      : base.assigneeAuto
        ? { assigneeId: defaultAssigneeOf(ws, base.teamId, templateProject(tpl, base)) }
        : {};

  const applyTemplate = (tpl: IssueTemplate) =>
    setForm((f) => {
      if (!f) return f;
      const base =
        tpl.teamId && tpl.teamId !== f.teamId
          ? { ...initial({ teamId: tpl.teamId }), title: f.title, description: f.description }
          : f;
      const tTeam = ws.teamById.get(base.teamId)!;
      const usable = tpl.labelIds.filter((id) => {
        const label = ws.labelById.get(id);
        return label && (!label.teamId || label.teamId === base.teamId);
      });
      return {
        ...base,
        title: base.title.trim() ? base.title : tpl.title,
        description: !base.description.trim()
          ? tpl.description
          : tpl.description.trim()
            ? `${base.description}\n\n${tpl.description}`
            : base.description,
        stateId:
          tpl.stateId && tTeam.states.some((s) => s.id === tpl.stateId)
            ? tpl.stateId
            : base.stateId,
        priority: tpl.priority ?? base.priority,
        ...templateAssignee(tpl, base),
        labelIds: [...new Set([...base.labelIds, ...usable])],
        projectId: templateProject(tpl, base),
        estimate: tpl.estimate ?? base.estimate,
      };
    });

  /**
   * Rewrites what's typed so far (title and description as notes) into a proper issue. Priority
   * and labels are only filled in, never replaced; Undo brings the notes back.
   */
  const draft = async () => {
    const notes = [form.title, form.description].filter((s) => s.trim()).join('\n\n');
    if (!notes.trim()) return;
    setDrafting(true);
    try {
      const d = await api.post<AiDraft>(wsPath(ws.slug, '/ai/draft'), {
        teamId: form.teamId,
        text: notes,
      });
      const before = form;
      setForm((f) =>
        f
          ? {
              ...f,
              title: d.title,
              description: d.description,
              priority: f.priority || d.priority,
              labelIds: [...new Set([...f.labelIds, ...d.labelIds])],
            }
          : f,
      );
      toast(t('issues.create.aiDone'), {
        action: { label: t('common.undo'), onClick: () => setForm(before) },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('issues.create.aiFailed'));
    } finally {
      setDrafting(false);
    }
  };

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
        toast.success(t('issues.create.created', { id: issue.identifier }), {
          description: issue.title,
          action: {
            label: t('issues.create.open'),
            onClick: () =>
              navigate({
                to: '/$slug/issue/$identifier',
                // Not numbered yet (made offline): its id finds it too.
                params: { slug: ws.slug, identifier: issue.number ? issue.identifier : issue.id },
              }),
          },
        });
        if (more) setForm((f) => (f ? { ...f, title: '', description: '' } : f));
        else close();
      },
    });
  };

  return (
    <Modal open onClose={close} width={720} label={t('issues.newIssue')}>
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
            placeholder={t('issues.create.moveToTeam')}
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
            {parent ? t('issues.create.newSubIssue') : t('issues.newIssue')}
          </span>
          {templates.length > 0 && (
            <Picker
              placeholder={t('issues.create.useTemplate')}
              options={templates.map((tpl) => ({
                value: tpl.id,
                label: tpl.name,
                hint: tpl.teamId ? ws.teamById.get(tpl.teamId)?.key : undefined,
                icon: <FileText size={14} className="text-index" />,
              }))}
              selected={[]}
              onSelect={(id) => {
                const tpl = templates.find((x) => x.id === id);
                if (tpl) applyTemplate(tpl);
              }}
              trigger={
                <button type="button" className="prop ml-2">
                  <FileText size={13} />
                  <span>{t('issues.create.template')}</span>
                </button>
              }
            />
          )}
          {aiEnabled && (
            <button
              type="button"
              className="prop ml-2"
              onClick={draft}
              disabled={drafting || !(form.title.trim() || form.description.trim())}
              title={t('issues.create.aiHint')}
            >
              <Sparkles size={13} />
              <span>{drafting ? t('issues.create.aiWriting') : t('issues.create.aiWrite')}</span>
            </button>
          )}
          <button
            type="button"
            className="ml-auto flex h-7 w-7 items-center justify-center text-index hover:text-text"
            onClick={close}
            aria-label={t('common.close')}
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
                e.currentTarget.parentElement
                  ?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
                  ?.focus();
              }
            }}
            placeholder={t('issues.create.titlePlaceholder')}
            className="mt-3 w-full bg-transparent text-[20px] font-semibold tracking-[-0.01em] outline-none placeholder:text-index"
          />
          <MarkdownEditor
            bare
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
            onSubmit={submit}
            placeholder={t('issues.create.descriptionPlaceholder')}
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
            {t('issues.create.createMore')}
          </label>
          <span className="ml-auto font-mono text-[11px] text-index">{modKey}+Enter</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!form.title.trim() || create.isPending}
          >
            {t('issues.create.submit')} <span className="arrow">→</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
