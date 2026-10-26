import type { IssueDetail, RelationView, UpdateIssueInput } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Bell, BellOff, Copy, Link2, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import { invalidateIssues, useUpdateIssue, useWsMutation } from '../api/queries.ts';
import { longDate, relativeTime } from '../lib/format.ts';
import { useHotkey } from '../lib/hotkeys.ts';
import { ui } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Activity } from './Activity.tsx';
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
  Picker,
  PriorityProp,
  ProjectProp,
  StatusProp,
  teamOptions,
} from './properties.tsx';
import { Avatar } from './ui/Avatar.tsx';
import { ConfirmModal } from './ui/Modal.tsx';
import { Popover } from './ui/Popover.tsx';

const RELATION_LABELS: Record<RelationView, string> = {
  blocks: 'Blocks',
  blocked_by: 'Blocked by',
  related: 'Related to',
  duplicate_of: 'Duplicate of',
  duplicated_by: 'Duplicated by',
};

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
    const t = value.trim();
    if (t && t !== issue.title) onSave(t);
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
      aria-label="Issue title"
    />
  );
}

function Description({ issue, onSave }: { issue: IssueDetail; onSave: (d: string) => void }) {
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
          placeholder="Add a description…"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save}>
            Save
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
        <p className="text-[14px] text-index">Add a description…</p>
      )}
    </div>
  );
}

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
}: {
  issue: IssueDetail;
  compact?: boolean;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const update = useUpdateIssue(ws.slug);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = (p: UpdateIssueInput) => update.mutate({ id: issue.id, patch: p });
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
  const addRelation = useWsMutation(ws.slug, (v: { type: string; relatedIssueId: string }) =>
    api.post(wsPath(ws.slug, `/issues/${issue.id}/relations`), v),
  );
  const removeRelation = useWsMutation(ws.slug, (id: string) =>
    api.del(wsPath(ws.slug, `/relations/${id}`)),
  );
  const done = () => invalidateIssues(qc, ws.slug);

  const trash = async () => {
    await api.del(wsPath(ws.slug, `/issues/${issue.id}`));
    done();
    toast(`${issue.identifier} moved to trash`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          await api.post(wsPath(ws.slug, `/issues/${issue.id}/restore`));
          done();
        },
      },
    });
    if (!compact)
      navigate({ to: '/$slug/team/$key/$tab', params: { ...p, key: team.key, tab: 'all' } });
  };

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text);
    toast.success(`Copied ${what}`);
  };

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
            {issue.deletedAt && <span className="text-error"> // in trash</span>}
          </>
        }
        title={compact ? issue.title : <span className="text-muted">{issue.identifier}</span>}
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => subscribe.mutate(!subscribed)}
              title={subscribed ? 'Unsubscribe' : 'Subscribe to updates'}
              aria-pressed={subscribed}
            >
              {subscribed ? <BellOff size={13} /> : <Bell size={13} />}
              <span className="hidden lg:inline">{subscribed ? 'Unsubscribe' : 'Subscribe'}</span>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                copy(`${location.origin}/${ws.slug}/issue/${issue.identifier}`, 'link')
              }
              aria-label="Copy link"
            >
              <Link2 size={13} />
            </button>
            <Popover
              placement="bottom-end"
              width={200}
              trigger={
                <button type="button" className="btn btn-ghost btn-sm" aria-label="More actions">
                  <MoreHorizontal size={14} />
                </button>
              }
            >
              {(close) => (
                <div className="py-1" onClick={close}>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => copy(issue.identifier, 'ID')}
                  >
                    <Copy size={14} /> Copy ID
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() =>
                      copy(
                        `${issue.identifier.toLowerCase()}-${issue.title
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, '-')
                          .slice(0, 40)
                          .replace(/-$/, '')}`,
                        'branch name',
                      )
                    }
                  >
                    <Copy size={14} /> Copy git branch name
                  </button>
                  <button
                    type="button"
                    className="menu-item text-error"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={14} /> Move to trash
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

            {/* Sub-issues */}
            <section className="mt-8">
              <div className="mb-2 flex items-center gap-3">
                <div className="section-label flex-1">
                  Sub-issues
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
                  <Plus size={12} /> Add
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
                      <span className="chip [--chip:var(--color-success)]">done</span>
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
              <div className="mb-2 flex items-center gap-3">
                <div className="section-label flex-1">Relations</div>
                <select
                  value={relType}
                  onChange={(e) => setRelType(e.target.value as typeof relType)}
                  className="h-[1.625rem] border border-border bg-bg px-1.5 text-[12px] text-muted outline-none focus:border-primary"
                  aria-label="Relation type"
                >
                  <option value="related">Related to</option>
                  <option value="blocks">Blocks</option>
                  <option value="blocked_by">Blocked by</option>
                  <option value="duplicate_of">Duplicate of</option>
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
                      <Plus size={12} /> Link
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
                      {RELATION_LABELS[r.type]}
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
                      aria-label="Remove relation"
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </section>

            <IssueLinks issue={issue} onChange={done} />

            <Activity issue={issue} />
          </div>
        </div>

        <aside className="hidden w-72 flex-none overflow-y-auto border-l border-border-soft bg-surface/40 p-4 lg:block">
          <div className="section-label mb-3">Properties</div>
          <Field label="Status">
            <StatusProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          <Field label="Priority">
            <PriorityProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          <Field label="Assignee">
            <AssigneeProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          <Field label="Labels">
            <LabelsProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          <Field label="Project">
            <ProjectProp issue={issue} onPatch={patch} variant="field" />
          </Field>
          {team.cyclesEnabled && (
            <Field label="Cycle">
              <CycleProp issue={issue} onPatch={patch} variant="field" />
            </Field>
          )}
          {team.estimateScale !== 'none' && (
            <Field label="Estimate">
              <EstimateProp issue={issue} onPatch={patch} variant="field" />
            </Field>
          )}
          <Field label="Due date">
            <DueDateProp
              issue={issue}
              onPatch={patch}
              variant="field"
              done={!!issue.completedAt || !!issue.canceledAt}
            />
          </Field>
          <Field label="Team">
            <Picker
              placeholder="Move to team…"
              options={teamOptions(ws)}
              selected={[issue.teamId]}
              onSelect={(teamId) => {
                if (teamId === issue.teamId) return;
                api
                  .patch<{ identifier: string }>(wsPath(ws.slug, `/issues/${issue.id}`), { teamId })
                  .then((moved) => {
                    done();
                    toast.success(`Moved to ${moved.identifier}`);
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
                  className="prop w-full justify-start bg-transparent shadow-none hover:bg-white/[0.03]"
                >
                  <TeamIcon color={team.color} label={team.key} size={14} />
                  {team.name}
                </button>
              }
            />
          </Field>
          <Field label="Parent">
            <div className="flex items-center gap-1">
              <IssueSearchPicker
                exclude={[issue.id, ...issue.subIssues.map((s) => s.id)]}
                onPick={(parent) => patch({ parentId: parent.id })}
                trigger={
                  <button
                    type="button"
                    className="prop min-w-0 flex-1 justify-start bg-transparent shadow-none hover:bg-white/[0.03]"
                  >
                    <span className="truncate">
                      {issue.parent ? issue.parent.identifier : 'Set parent'}
                    </span>
                  </button>
                }
              />
              {issue.parent && (
                <button
                  type="button"
                  className="flex h-6 w-6 flex-none items-center justify-center text-index hover:text-text"
                  onClick={() => patch({ parentId: null })}
                  aria-label="Remove parent"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </Field>

          <div className="mt-6 border-t border-border-soft pt-4 font-mono text-[11px] leading-6 text-index">
            <div>
              <span className="text-muted">&gt; created</span> {relativeTime(issue.createdAt)}
              {creator && <> by {creator.name}</>}
            </div>
            <div title={longDate(issue.updatedAt)}>
              <span className="text-muted">&gt; updated</span> {relativeTime(issue.updatedAt)}
            </div>
            {issue.completedAt && (
              <div>
                <span className="text-muted">&gt; completed</span> {relativeTime(issue.completedAt)}
              </div>
            )}
            <div>
              <span className="text-muted">&gt; subscribers</span> {issue.subscriberIds.length}
            </div>
          </div>
        </aside>
      </div>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Move ${issue.identifier} to trash?`}
        body="You can restore it from the trash later."
        confirmLabel="Move to trash"
        danger
        onConfirm={trash}
      />
    </div>
  );
}
