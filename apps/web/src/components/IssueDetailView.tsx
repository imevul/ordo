import {
  branchName,
  type IssueDetail,
  type RelationView,
  type UpdateIssueInput,
} from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Copy,
  Link2,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import {
  invalidateIssues,
  useAttachmentUpload,
  useUpdateIssue,
  useWsMutation,
} from '../api/queries.ts';
import { type MessageKey, t, tx } from '../i18n/index.ts';
import { longDate, relativeTime, slaState } from '../lib/format.ts';
import { useHotkey } from '../lib/hotkeys.ts';
import { isDone } from '../lib/issues.ts';
import { ui } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { useSyncEngine } from '../sync/context.tsx';
import { Activity } from './Activity.tsx';
import { AgentRuns } from './AgentRuns.tsx';
import { type AiPanelKind, IssueAiPanel, useAiEnabled } from './AiAssist.tsx';
import { CustomerRequests } from './CustomerRequests.tsx';
import { IssueAttachments } from './IssueAttachments.tsx';
import { IssueLinks } from './IssueLinks.tsx';
import { IssueSearchPicker } from './IssueSearchPicker.tsx';
import { StatusIcon, TeamIcon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { MarkdownEditor } from './MarkdownEditor.tsx';
import { PageHeader, Sep } from './PageHeader.tsx';
import {
  AssigneeProp,
  CycleProp,
  DueDateProp,
  EstimateProp,
  LabelsProp,
  MilestoneProp,
  Picker,
  PriorityProp,
  ProjectProp,
  StatusProp,
  teamOptions,
} from './properties.tsx';
import { ActorName } from './ui/ActorName.tsx';
import { Avatar } from './ui/Avatar.tsx';
import { ConfirmModal } from './ui/Modal.tsx';
import { Popover } from './ui/Popover.tsx';

const RELATION_KEYS = {
  blocks: 'issue.relations.blocks',
  blocked_by: 'issue.relations.blockedBy',
  related: 'issue.relations.related',
  duplicate_of: 'issue.relations.duplicateOf',
  duplicated_by: 'issue.relations.duplicatedBy',
} as const satisfies Record<RelationView, MessageKey>;

function Title({ issue, onSave }: { issue: IssueDetail; onSave: (title: string) => void }) {
  const [value, setValue] = useState(issue.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setValue(issue.title), [issue.title]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useLayoutEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [value]);
  const commit = () => {
    const next = value.trim();
    if (next && next !== issue.title) onSave(next);
    else setValue(issue.title);
  };
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          setValue(issue.title);
          e.currentTarget.blur();
        }
      }}
      className="w-full resize-none overflow-hidden bg-transparent text-[24px] leading-tight font-bold tracking-[-0.02em] outline-none"
      aria-label={t('issue.detail.titleLabel')}
    />
  );
}

function Description({ issue, onSave }: { issue: IssueDetail; onSave: (d: string) => void }) {
  const ws = useWorkspace();
  const upload = useAttachmentUpload(ws.slug, issue.id);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(issue.description);
  useEffect(() => {
    if (!editing) setValue(issue.description);
  }, [issue.description, editing]);
  const save = () => {
    if (value !== issue.description) onSave(value);
    setEditing(false);
  };
  if (editing) {
    return (
      <div className="mt-4">
        <MarkdownEditor
          value={value}
          onChange={setValue}
          onSubmit={save}
          onCancel={() => setEditing(false)}
          autoFocus
          minRows={6}
          placeholder={t('issue.detail.addDescription')}
          onUpload={upload}
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="mt-4 min-h-12 cursor-text"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,input')) return;
        setEditing(true);
      }}
    >
      {issue.description.trim() ? (
        <Markdown source={issue.description} />
      ) : (
        <p className="text-[14px] text-index">{t('issue.detail.addDescription')}</p>
      )}
    </div>
  );
}

/** The dim "> created" style keyword in the issue's metadata lines. */
const k = (s: ReactNode) => <span className="text-muted">{s}</span>;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-center gap-2 py-0.5">
      <span className="text-[12px] text-index">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function IssueDetailView({
  issue,
  compact = false,
  focusCommentId,
}: {
  issue: IssueDetail;
  compact?: boolean;
  focusCommentId?: string | null;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const update = useUpdateIssue(ws.slug);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const aiEnabled = useAiEnabled();
  const [aiPanel, setAiPanel] = useState<AiPanelKind | null>(null);
  // A panel belongs to the issue it was opened on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the issue changes
  useEffect(() => setAiPanel(null), [issue.id]);
  const patch = (p: UpdateIssueInput) => update.mutate({ id: issue.id, patch: p });
  const sla = slaState(issue, isDone(ws, issue));
  const team = ws.teamById.get(issue.teamId)!;
  const creator = issue.creatorId ? ws.memberById.get(issue.creatorId) : undefined;
  const subscribed = issue.subscriberIds.includes(ws.me.id);
  const p = { slug: ws.slug };

  useEffect(() => {
    if (compact) return;
    ui.set({ contextIssues: [issue.id] });
    return () => ui.set({ contextIssues: [] });
  }, [issue.id, compact]);

  useHotkey('s', () => ui.openPalette('status', [issue.id]), { enabled: !compact });
  useHotkey('p', () => ui.openPalette('priority', [issue.id]), { enabled: !compact });
  useHotkey('a', () => ui.openPalette('assignee', [issue.id]), { enabled: !compact });
  useHotkey('l', () => ui.openPalette('labels', [issue.id]), { enabled: !compact });
  useHotkey('shift+p', () => ui.openPalette('project', [issue.id]), { enabled: !compact });
  useHotkey('shift+c', () => ui.openPalette('cycle', [issue.id]), { enabled: !compact });
  useHotkey('e', () => ui.openPalette('estimate', [issue.id]), { enabled: !compact });
  useHotkey('i', () => patch({ assigneeId: issue.assigneeId === ws.me.id ? null : ws.me.id }), {
    enabled: !compact,
  });

  const subscribe = useWsMutation(ws.slug, (on: boolean) =>
    on
      ? api.post(wsPath(ws.slug, `/issues/${issue.id}/subscription`))
      : api.del(wsPath(ws.slug, `/issues/${issue.id}/subscription`)),
  );
  const archive = useWsMutation(
    ws.slug,
    (on: boolean) =>
      api.post(wsPath(ws.slug, `/issues/${issue.id}/${on ? 'archive' : 'unarchive'}`)),
    {
      invalidate: [
        ['ws', ws.slug, 'issues'],
        ['ws', ws.slug, 'issue'],
      ],
    },
  );
  const engine = useSyncEngine();
  const addRelation = useWsMutation(ws.slug, (v: { type: string; relatedIssueId: string }) =>
    engine
      ? engine.mutate({
          kind: 'relation.create',
          relation: { id: crypto.randomUUID(), issueId: issue.id, ...v },
        })
      : api.post(wsPath(ws.slug, `/issues/${issue.id}/relations`), v),
  );
  const removeRelation = useWsMutation(ws.slug, (id: string) =>
    engine
      ? engine.mutate({ kind: 'relation.delete', id })
      : api.del(wsPath(ws.slug, `/relations/${id}`)),
  );
  const done = () => invalidateIssues(qc, ws.slug);

  const trash = async () => {
    await api.del(wsPath(ws.slug, `/issues/${issue.id}`));
    done();
    toast(t('issue.detail.trashed', { identifier: issue.identifier }), {
      action: {
        label: t('common.undo'),
        onClick: async () => {
          await api.post(wsPath(ws.slug, `/issues/${issue.id}/restore`));
          done();
        },
      },
    });
    if (!compact)
      navigate({ to: '/$slug/team/$key/$tab', params: { ...p, key: team.key, tab: 'all' } });
  };

  const copy = (text: string, message: string) => {
    navigator.clipboard?.writeText(text);
    toast.success(message);
  };

  // Linking a PR is as easy as naming the branch after the issue.
  const copyBranch = () =>
    copy(
      branchName(ws.workspace.settings.gitBranchFormat, {
        identifier: issue.identifier,
        title: issue.title,
        username: ws.me.username,
      }),
      t('issue.detail.branchCopied'),
    );
  useHotkey('mod+>', copyBranch, { enabled: !compact });

  const [relType, setRelType] = useState<'blocks' | 'blocked_by' | 'related' | 'duplicate_of'>(
    'related',
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            <Link
              to="/$slug/team/$key/$tab"
              params={{ ...p, key: team.key, tab: 'all' }}
              className="hover:text-highlight"
            >
              {team.name}
            </Link>
            <Sep />
            {issue.identifier}
            {issue.deletedAt && <span className="text-error"> {t('issue.detail.inTrash')}</span>}
            {issue.archivedAt && !issue.deletedAt && (
              <span className="text-index"> {t('issue.detail.archived')}</span>
            )}
          </>
        }
        title={compact ? issue.title : <span className="text-muted">{issue.identifier}</span>}
        actions={
          <>
            {aiEnabled && (
              <Popover
                placement="bottom-end"
                width={200}
                trigger={
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={t('issue.detail.askAi')}
                  >
                    <Sparkles size={13} />
                    <span className="hidden lg:inline">{t('issue.detail.askAi')}</span>
                  </button>
                }
              >
                {(close) => (
                  <div className="py-1" onClick={close}>
                    <button
                      type="button"
                      className="menu-item"
                      onClick={() => setAiPanel('summary')}
                    >
                      {t('issue.detail.summarize')}
                    </button>
                    <button
                      type="button"
                      className="menu-item"
                      onClick={() => setAiPanel('triage')}
                    >
                      {t('issue.detail.suggestProperties')}
                    </button>
                  </div>
                )}
              </Popover>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => subscribe.mutate(!subscribed)}
              title={subscribed ? t('issue.detail.unsubscribe') : t('issue.detail.subscribeTitle')}
              aria-pressed={subscribed}
            >
              {subscribed ? <BellOff size={13} /> : <Bell size={13} />}
              <span className="hidden lg:inline">
                {subscribed ? t('issue.detail.unsubscribe') : t('issue.detail.subscribe')}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                copy(
                  `${location.origin}/${ws.slug}/issue/${issue.identifier}`,
                  t('issue.detail.linkCopied'),
                )
              }
              aria-label={t('issue.detail.copyLink')}
            >
              <Link2 size={13} />
            </button>
            <Popover
              placement="bottom-end"
              width={200}
              trigger={
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('issue.detail.moreActions')}
                >
                  <MoreHorizontal size={14} />
                </button>
              }
            >
              {(close) => (
                <div className="py-1" onClick={close}>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => copy(issue.identifier, t('issue.detail.idCopied'))}
                  >
                    <Copy size={14} /> {t('issue.detail.copyId')}
                  </button>
                  <button type="button" className="menu-item" onClick={copyBranch}>
                    <Copy size={14} /> {t('issue.detail.copyBranch')}
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => archive.mutate(!issue.archivedAt)}
                  >
                    {issue.archivedAt ? (
                      <>
                        <ArchiveRestore size={14} /> {t('common.unarchive')}
                      </>
                    ) : (
                      <>
                        <Archive size={14} /> {t('common.archive')}
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="menu-item text-error"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={14} /> {t('issue.detail.moveToTrash')}
                  </button>
                </div>
              )}
            </Popover>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-8">
            {issue.parent && (
              <Link
                to="/$slug/issue/$identifier"
                params={{ ...p, identifier: issue.parent.identifier }}
                className="mb-3 inline-flex items-center gap-2 font-mono text-[11.5px] text-index hover:text-highlight"
              >
                <span className="text-muted">↑</span> {issue.parent.identifier}{' '}
                <span className="font-sans text-muted">{issue.parent.title}</span>
              </Link>
            )}
            <Title issue={issue} onSave={(title) => patch({ title })} />
            <Description issue={issue} onSave={(description) => patch({ description })} />
            {aiPanel && (
              <IssueAiPanel
                key={aiPanel}
                kind={aiPanel}
                issue={issue}
                onPatch={patch}
                onClose={() => setAiPanel(null)}
              />
            )}

            {/* Sub-issues */}
            <section className="mt-8">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="section-label flex-1">
                  {t('issue.detail.subIssues')}
                  {issue.subIssues.length > 0 && (
                    <span className="text-muted">
                      {issue.completedSubIssueCount}/{issue.subIssueCount}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    ui.openCreateIssue({
                      teamId: issue.teamId,
                      parentId: issue.id,
                      projectId: issue.projectId,
                      cycleId: issue.cycleId,
                    })
                  }
                >
                  <Plus size={12} /> {t('common.add')}
                </button>
              </div>
              {issue.subIssues.map((s) => {
                const st = ws.stateById.get(s.stateId);
                const assignee = s.assigneeId ? ws.memberById.get(s.assigneeId) : null;
                return (
                  <div
                    key={s.id}
                    className="row flex h-9 items-center gap-2.5 border-b border-border-soft/60 px-2"
                  >
                    <StatusProp
                      issue={s}
                      onPatch={(pp) => update.mutate({ id: s.id, patch: pp })}
                      variant="icon"
                    />
                    <span className="w-16 flex-none font-mono text-[11px] text-index">
                      {s.identifier}
                    </span>
                    <Link
                      to="/$slug/issue/$identifier"
                      params={{ ...p, identifier: s.identifier }}
                      className="min-w-0 flex-1 truncate text-[13.5px]"
                    >
                      {s.title}
                    </Link>
                    {st?.type === 'completed' && (
                      <span className="chip [--chip:var(--color-success)]">{t('common.done')}</span>
                    )}
                    {assignee && (
                      <Avatar
                        name={assignee.name}
                        color={assignee.avatarColor}
                        src={assignee.avatarUrl}
                        size={16}
                      />
                    )}
                  </div>
                );
              })}
            </section>

            {/* Relations */}
            <section className="mt-8">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="section-label flex-1">{t('issue.relations.title')}</div>
                <select
                  value={relType}
                  onChange={(e) => setRelType(e.target.value as typeof relType)}
                  className="h-[1.625rem] border border-border bg-bg px-1.5 text-[12px] text-muted outline-none focus:border-primary"
                  aria-label={t('issue.relations.type')}
                >
                  {(['related', 'blocks', 'blocked_by', 'duplicate_of'] as const).map((type) => (
                    <option key={type} value={type}>
                      {t(RELATION_KEYS[type])}
                    </option>
                  ))}
                </select>
                <IssueSearchPicker
                  exclude={[issue.id, ...issue.relations.map((r) => r.issue.id)]}
                  onPick={(other) =>
                    addRelation.mutate(
                      { type: relType, relatedIssueId: other.id },
                      { onSuccess: done },
                    )
                  }
                  trigger={
                    <button type="button" className="btn btn-ghost btn-sm">
                      <Plus size={12} /> {t('issue.relations.link')}
                    </button>
                  }
                />
              </div>
              {issue.relations.map((r) => {
                const st = ws.stateById.get(r.issue.stateId);
                return (
                  <div
                    key={r.id}
                    className="row group flex h-9 items-center gap-2.5 border-b border-border-soft/60 px-2"
                  >
                    <span
                      className={`w-24 flex-none font-mono text-[10.5px] tracking-[0.08em] uppercase ${r.type === 'blocked_by' ? 'text-warning' : 'text-index'}`}
                    >
                      {t(RELATION_KEYS[r.type])}
                    </span>
                    {st && <StatusIcon type={st.type} color={st.color} />}
                    <span className="w-16 flex-none font-mono text-[11px] text-index">
                      {r.issue.identifier}
                    </span>
                    <Link
                      to="/$slug/issue/$identifier"
                      params={{ ...p, identifier: r.issue.identifier }}
                      className="min-w-0 flex-1 truncate text-[13.5px]"
                    >
                      {r.issue.title}
                    </Link>
                    <button
                      type="button"
                      className="flex h-6 w-6 items-center justify-center text-index opacity-0 group-hover:opacity-100 hover:text-text"
                      onClick={() => removeRelation.mutate(r.id, { onSuccess: done })}
                      aria-label={t('issue.relations.remove')}
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </section>

            <IssueAttachments issue={issue} onChange={done} />
            <IssueLinks issue={issue} onChange={done} />
            <AgentRuns issue={issue} />
            <CustomerRequests issue={issue} onChange={done} />

            <Activity issue={issue} focusCommentId={focusCommentId} />
          </div>
        </div>

        <aside className="hidden w-72 flex-none overflow-y-auto border-l border-border-soft bg-surface/40 p-4 lg:block">
          <div className="section-label mb-3">{t('issue.detail.properties')}</div>
          <Field label={t('common.status')}>
            <StatusProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          <Field label={t('common.priority')}>
            <PriorityProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          <Field label={t('common.assignee')}>
            <AssigneeProp issue={issue} onPatch={patch} variant="field" />
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
            <LabelsProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          <Field label={t('common.project')}>
            <ProjectProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          {issue.projectId && !!ws.projectById.get(issue.projectId)?.milestones.length && (
            <Field label={t('common.milestone')}>
              <MilestoneProp issue={issue} onPatch={patch} variant="field" />
            </Field>
          )}
          {team.cyclesEnabled && (
            <Field label={t('common.cycle')}>
              <CycleProp issue={issue} onPatch={patch} variant="field" />
            </Field>
          )}
          {team.estimateScale !== 'none' && (
            <Field label={t('common.estimate')}>
              <EstimateProp issue={issue} onPatch={patch} variant="field" />
            </Field>
          )}
          <Field label={t('common.dueDate')}>
            <DueDateProp
              issue={issue}
              onPatch={patch}
              variant="field"
              done={!!issue.completedAt || !!issue.canceledAt}
            />
          </Field>
          <Field label={t('common.team')}>
            <Picker
              placeholder={t('issue.detail.moveToTeam')}
              options={teamOptions(ws)}
              selected={[issue.teamId]}
              onSelect={(teamId) => {
                if (teamId === issue.teamId) return;
                api
                  .patch<{ identifier: string }>(wsPath(ws.slug, `/issues/${issue.id}`), { teamId })
                  .then((moved) => {
                    done();
                    toast.success(t('issue.detail.movedTo', { identifier: moved.identifier }));
                    if (!compact)
                      navigate({
                        to: '/$slug/issue/$identifier',
                        params: { ...p, identifier: moved.identifier },
                        replace: true,
                      });
                  });
              }}
              trigger={
                <button
                  type="button"
                  className="prop w-full justify-start bg-transparent shadow-none hover:bg-text/[0.03]"
                >
                  <TeamIcon color={team.color} label={team.key} size={14} />
                  {team.name}
                </button>
              }
            />
          </Field>
          <Field label={t('common.parent')}>
            <div className="flex items-center gap-1">
              <IssueSearchPicker
                exclude={[issue.id, ...issue.subIssues.map((s) => s.id)]}
                onPick={(parent) => patch({ parentId: parent.id })}
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
                  onClick={() => patch({ parentId: null })}
                  aria-label={t('issue.detail.removeParent')}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </Field>

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
              <div>
                {tx('issue.detail.completed', { k, time: relativeTime(issue.completedAt) })}
              </div>
            )}
            <div>{tx('issue.detail.subscribers', { k, count: issue.subscriberIds.length })}</div>
          </div>
        </aside>
      </div>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('issue.detail.confirmTrashTitle', { identifier: issue.identifier })}
        body={t('issue.detail.confirmTrashBody')}
        confirmLabel={t('issue.detail.moveToTrash')}
        danger
        onConfirm={trash}
      />
    </div>
  );
}
