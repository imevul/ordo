import type {
  Comment,
  CustomFieldValue,
  HistoryChange,
  HistoryEntry,
  IssueDetail,
} from '@ordo/shared';
import { MoreHorizontal, Reply } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import {
  keys,
  useAttachmentUpload,
  useComments,
  useHistory,
  useWsMutation,
} from '../api/queries.ts';
import { getLocale, INTL_TAG, t, tx } from '../i18n/index.ts';
import { estimateLabel, priorityLabel } from '../i18n/labels.ts';
import { optionName, valueText } from '../lib/customFields.ts';
import { longDate, relativeTime, shortDate } from '../lib/format.ts';
import { cycleName, useWorkspace } from '../lib/workspace.tsx';
import { useSyncEngine } from '../sync/context.tsx';
import { PriorityIcon, StatusIcon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { MarkdownEditor } from './MarkdownEditor.tsx';
import { ReactionBar, ReactionPicker } from './Reactions.tsx';
import { ActorName } from './ui/ActorName.tsx';
import { Avatar } from './ui/Avatar.tsx';
import { Popover } from './ui/Popover.tsx';

/** "Ada, Bo and Cy" in the reader's language. */
const list = (items: string[]) =>
  new Intl.ListFormat(INTL_TAG[getLocale()], { type: 'conjunction' }).format(items);

/** History entries for custom field values are `customField:<fieldId>`. */
const FIELD_CHANGE = 'customField:';

/** A custom field value change: set, cleared, or options added and removed. */
function FieldChangeText({
  c,
  actor,
  strong,
}: {
  c: HistoryChange;
  actor: ReactNode;
  strong: (x: ReactNode) => ReactNode;
}) {
  const ws = useWorkspace();
  const field = ws.customFieldById.get(c.field.slice(FIELD_CHANGE.length));
  // Without the field there is no telling what its values meant.
  if (!field)
    return tx('issue.activity.changed', {
      actor,
      field: strong(t('customFields.activity.deletedField')),
    });
  const name = strong(field.name);
  if (c.to == null || (Array.isArray(c.to) && c.to.length === 0))
    return tx('customFields.activity.cleared', { actor, field: name });
  if (field.type === 'multi_select' && Array.isArray(c.to)) {
    const from = Array.isArray(c.from) ? (c.from as string[]) : [];
    const to = c.to as string[];
    const added = to.filter((o) => !from.includes(o)).map((o) => optionName(field, o));
    const removed = from.filter((o) => !to.includes(o)).map((o) => optionName(field, o));
    if (added.length && removed.length)
      return tx('customFields.activity.changed', {
        actor,
        field: name,
        added: strong(list(added)),
        removed: strong(list(removed)),
      });
    if (removed.length)
      return tx('customFields.activity.removed', {
        actor,
        field: name,
        values: strong(list(removed)),
      });
    return tx('customFields.activity.added', { actor, field: name, values: strong(list(added)) });
  }
  return tx('customFields.activity.set', {
    actor,
    field: name,
    value: strong(valueText(ws, field, c.to as CustomFieldValue)),
  });
}

/** One history line: who did what, as a single message so translations can order the words. */
function ChangeText({
  c,
  actor,
  actorId,
  issue,
}: {
  c: HistoryChange;
  actor: ReactNode;
  actorId: string | null;
  issue: IssueDetail;
}) {
  const ws = useWorkspace();
  const name = (id: unknown) =>
    typeof id === 'string'
      ? (ws.memberById.get(id)?.name ?? t('issue.activity.fallback.someone'))
      : t('issue.activity.fallback.nobody');
  const strong = (x: ReactNode) => <span className="text-text">{x}</span>;
  if (c.field.startsWith(FIELD_CHANGE))
    return <FieldChangeText c={c} actor={actor} strong={strong} />;
  switch (c.field) {
    case 'created':
      return tx('issue.activity.created', { actor });
    case 'deleted':
      return tx('issue.activity.trashed', { actor });
    case 'restored':
      return tx('issue.activity.restored', { actor });
    case 'archived':
      return tx(c.to ? 'issue.activity.archived' : 'issue.activity.unarchived', { actor });
    case 'state': {
      const s = ws.stateById.get(c.to as string);
      return tx('issue.activity.status', {
        actor,
        status: s ? (
          <span className="inline-flex items-center gap-1 align-[-2px] text-text">
            <StatusIcon type={s.type} color={s.color} size={12} /> {s.name}
          </span>
        ) : (
          strong(t('issue.activity.fallback.status'))
        ),
      });
    }
    case 'assignee':
      if (!c.to) return tx('issue.activity.assigneeRemoved', { actor, name: strong(name(c.from)) });
      if (c.to === actorId) return tx('issue.activity.selfAssigned', { actor });
      return tx('issue.activity.assigned', { actor, name: strong(name(c.to)) });
    case 'priority':
      return tx('issue.activity.priority', {
        actor,
        priority: (
          <span className="inline-flex items-center gap-1 align-[-2px] text-text">
            <PriorityIcon priority={c.to as number} size={12} /> {priorityLabel(c.to as number)}
          </span>
        ),
      });
    case 'title':
      return tx('issue.activity.title', { actor, title: String(c.to), b: strong });
    case 'description':
      return tx('issue.activity.description', { actor });
    case 'labels': {
      const from = (c.from as string[]) ?? [];
      const to = (c.to as string[]) ?? [];
      const labelName = (l: string) =>
        ws.labelById.get(l)?.name ?? t('issue.activity.fallback.label');
      const added = to.filter((l) => !from.includes(l)).map(labelName);
      const removed = from.filter((l) => !to.includes(l)).map(labelName);
      if (added.length && removed.length)
        return tx('issue.activity.labelsChanged', {
          actor,
          added: strong(list(added)),
          removed: strong(list(removed)),
        });
      if (added.length)
        return tx('issue.activity.labelsAdded', { actor, labels: strong(list(added)) });
      return tx('issue.activity.labelsRemoved', { actor, labels: strong(list(removed)) });
    }
    case 'project':
      return c.to
        ? tx('issue.activity.projectSet', {
            actor,
            project: strong(
              ws.projectById.get(c.to as string)?.name ?? t('issue.activity.fallback.project'),
            ),
          })
        : tx('issue.activity.projectRemoved', { actor });
    case 'milestone': {
      const m = ws.projects.flatMap((p) => p.milestones).find((x) => x.id === c.to);
      return c.to
        ? tx('issue.activity.milestoneSet', {
            actor,
            milestone: strong(m?.name ?? t('issue.activity.fallback.milestone')),
          })
        : tx('issue.activity.milestoneRemoved', { actor });
    }
    case 'cycle': {
      const cy = c.to ? ws.cycleById.get(c.to as string) : null;
      return c.to
        ? tx('issue.activity.cycleSet', {
            actor,
            cycle: strong(cy ? cycleName(cy) : t('issue.activity.fallback.cycle')),
          })
        : tx('issue.activity.cycleRemoved', { actor });
    }
    case 'release': {
      const r = c.to ? ws.releaseById.get(c.to as string) : null;
      return c.to
        ? tx('issue.activity.releaseSet', {
            actor,
            release: strong(r?.name ?? t('issue.activity.fallback.release')),
          })
        : tx('issue.activity.releaseRemoved', { actor });
    }
    case 'parent':
      if (!c.to) return tx('issue.activity.parentRemoved', { actor });
      return issue.parent
        ? tx('issue.activity.subIssueOf', { actor, parent: strong(issue.parent.identifier) })
        : tx('issue.activity.subIssue', { actor });
    case 'estimate': {
      const team = ws.teamById.get(issue.teamId);
      return c.to == null
        ? tx('issue.activity.estimateRemoved', { actor })
        : tx('issue.activity.estimateSet', {
            actor,
            estimate: strong(estimateLabel(team?.estimateScale ?? 'linear', c.to as number)),
          });
    }
    case 'planApproval':
      return c.to === true
        ? tx('issue.activity.planApprovalOn', { actor })
        : c.to === false
          ? tx('issue.activity.planApprovalOff', { actor })
          : tx('issue.activity.planApprovalDefault', { actor });
    case 'dueDate':
      return c.to
        ? tx('issue.activity.dueDateSet', { actor, date: strong(shortDate(c.to as string)) })
        : tx('issue.activity.dueDateRemoved', { actor });
    case 'team':
      return tx('issue.activity.team', {
        actor,
        from: strong(
          ws.teamById.get(c.from as string)?.name ?? t('issue.activity.fallback.fromTeam'),
        ),
        to: strong(ws.teamById.get(c.to as string)?.name ?? t('issue.activity.fallback.toTeam')),
      });
    case 'automation':
      return tx('issue.activity.automation', {
        actor,
        rule: strong((c.to as { name?: string } | null)?.name ?? ''),
      });
    default:
      return tx('issue.activity.changed', { actor, field: c.field });
  }
}

function HistoryItem({ entry, issue }: { entry: HistoryEntry; issue: IssueDetail }) {
  const ws = useWorkspace();
  const actor = entry.actorId ? ws.memberById.get(entry.actorId) : null;
  return (
    <>
      {entry.changes.map((c, i) => (
        <div key={i} className="flex items-start gap-2.5 py-1.5 pl-1 text-[12.5px] text-muted">
          <span className="mt-[3px] h-[7px] w-[7px] flex-none bg-border" aria-hidden />
          <span className="min-w-0">
            <ChangeText
              c={c}
              actor={<ActorName person={actor} fallback={t('issue.activity.someone')} />}
              actorId={entry.actorId}
              issue={issue}
            />
            <span className="text-index" title={longDate(entry.createdAt)}>
              {' '}
              · {relativeTime(entry.createdAt)}
            </span>
          </span>
        </div>
      ))}
    </>
  );
}

function CommentItem({
  comment,
  replies,
  issueId,
  focusId,
}: {
  comment: Comment;
  replies: Comment[];
  issueId: string;
  focusId?: string | null;
}) {
  const ws = useWorkspace();
  const upload = useAttachmentUpload(ws.slug, issueId);
  const author = comment.authorId ? ws.memberById.get(comment.authorId) : undefined;
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const inv = [keys.comments(ws.slug, issueId)];
  // With a local copy, comments go through its outbox (and work offline).
  const engine = useSyncEngine();
  const save = useWsMutation(
    ws.slug,
    (b: string) =>
      engine
        ? engine.mutate({ kind: 'comment.update', id: comment.id, issueId, body: b })
        : api.patch(wsPath(ws.slug, `/comments/${comment.id}`), { body: b }),
    { invalidate: inv },
  );
  const remove = useWsMutation(
    ws.slug,
    () =>
      engine
        ? engine.mutate({ kind: 'comment.delete', id: comment.id, issueId })
        : api.del(wsPath(ws.slug, `/comments/${comment.id}`)),
    { invalidate: inv },
  );
  const sendReply = useWsMutation(
    ws.slug,
    (b: string) =>
      engine
        ? engine.mutate({
            kind: 'comment.create',
            comment: { id: crypto.randomUUID(), issueId, body: b, parentId: comment.id },
          })
        : api.post(wsPath(ws.slug, `/issues/${issueId}/comments`), {
            body: b,
            parentId: comment.id,
          }),
    { invalidate: inv },
  );
  const mine = comment.authorId === ws.me.id;

  return (
    <div
      id={`comment-${comment.id}`}
      className="panel panel-sm comment my-2"
      data-focused={focusId === comment.id || undefined}
    >
      <div className="p-3.5">
        <div className="flex items-center gap-2 text-[12.5px]">
          {author && (
            <Avatar
              name={author.name}
              color={author.avatarColor}
              src={author.avatarUrl}
              size={18}
              status={author.status}
            />
          )}
          <ActorName
            person={author}
            fallback={t('issue.comments.formerMember')}
            className="font-medium"
          />
          <span className="text-index" title={longDate(comment.createdAt)}>
            {relativeTime(comment.createdAt)}
            {comment.editedAt && ` · ${t('issue.comments.edited')}`}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <ReactionPicker comment={comment} issueId={issueId} />
            {!comment.parentId && (
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
                onClick={() => setReplying(true)}
                aria-label={t('issue.comments.reply')}
              >
                <Reply size={13} />
              </button>
            )}
            {(mine || ws.isAdmin) && (
              <Popover
                placement="bottom-end"
                width={160}
                trigger={
                  <button
                    type="button"
                    className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
                    aria-label={t('issue.comments.actions')}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                }
              >
                {(close) => (
                  <div className="py-1">
                    {mine && (
                      <button
                        type="button"
                        className="menu-item"
                        onClick={() => {
                          setEditing(true);
                          close();
                        }}
                      >
                        {t('common.edit')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="menu-item text-error"
                      onClick={() => {
                        remove.mutate(undefined);
                        close();
                      }}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                )}
              </Popover>
            )}
          </div>
        </div>
        <div className="mt-2">
          {editing ? (
            <div>
              <MarkdownEditor
                value={body}
                onChange={setBody}
                onUpload={upload}
                autoFocus
                onSubmit={() => {
                  save.mutate(body);
                  setEditing(false);
                }}
                onCancel={() => {
                  setBody(comment.body);
                  setEditing(false);
                }}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setEditing(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    save.mutate(body);
                    setEditing(false);
                  }}
                >
                  {t('common.save')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <Markdown source={comment.body} />
              <ReactionBar comment={comment} issueId={issueId} />
            </>
          )}
        </div>
      </div>
      {(replies.length > 0 || replying) && (
        <div className="border-t border-border-soft px-3.5 pb-2">
          {replies.map((r) => (
            <CommentItem key={r.id} comment={r} replies={[]} issueId={issueId} focusId={focusId} />
          ))}
          {replying && (
            <div className="pt-2">
              <MarkdownEditor
                value={reply}
                onChange={setReply}
                onUpload={upload}
                autoFocus
                minRows={2}
                placeholder={t('issue.comments.replyPlaceholder')}
                onSubmit={() => {
                  if (!reply.trim()) return;
                  sendReply.mutate(reply);
                  setReply('');
                  setReplying(false);
                }}
                onCancel={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Activity({
  issue,
  focusCommentId,
}: {
  issue: IssueDetail;
  /** A comment to scroll to and outline, e.g. the one an inbox notification is about. */
  focusCommentId?: string | null;
}) {
  const ws = useWorkspace();
  const historyQuery = useHistory(ws.slug, issue.id);
  const history = historyQuery.data ?? [];
  const { data: comments = [] } = useComments(ws.slug, issue.id);
  const [draft, setDraft] = useState('');
  const upload = useAttachmentUpload(ws.slug, issue.id);
  const engine = useSyncEngine();
  const send = useWsMutation(
    ws.slug,
    (body: string) =>
      engine
        ? engine.mutate({
            kind: 'comment.create',
            comment: { id: crypto.randomUUID(), issueId: issue.id, body, parentId: null },
          })
        : api.post(wsPath(ws.slug, `/issues/${issue.id}/comments`), { body }),
    {
      invalidate: [keys.comments(ws.slug, issue.id)],
    },
  );

  const items = useMemo(() => {
    const top = comments.filter((c) => !c.parentId);
    const all: (
      | { kind: 'h'; at: string; h: HistoryEntry }
      | { kind: 'c'; at: string; c: Comment }
    )[] = [
      ...history.map((h) => ({ kind: 'h' as const, at: h.createdAt, h })),
      ...top.map((c) => ({ kind: 'c' as const, at: c.createdAt, c })),
    ];
    return all.sort((a, b) => a.at.localeCompare(b.at));
  }, [history, comments]);

  // History rows sort in above comments, and with offline sync the comments can arrive from
  // IndexedDB long before /history does, so wait for both or the comment moves after scrolling.
  // Scroll once, not again on every refetch.
  const focusReady = !historyQuery.isPending && comments.some((c) => c.id === focusCommentId);
  useEffect(() => {
    if (!focusCommentId || !focusReady) return;
    document
      .getElementById(`comment-${focusCommentId}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusCommentId, focusReady]);

  const submit = () => {
    if (!draft.trim()) return;
    send.mutate(draft);
    setDraft('');
  };

  return (
    <section className="mt-10">
      <div className="section-label mb-3">{t('issue.activity.heading')}</div>
      {items.map((it) =>
        it.kind === 'h' ? (
          <HistoryItem key={it.h.id} entry={it.h} issue={issue} />
        ) : (
          <CommentItem
            key={it.c.id}
            comment={it.c}
            replies={comments.filter((r) => r.parentId === it.c.id)}
            issueId={issue.id}
            focusId={focusCommentId}
          />
        ),
      )}
      <div className="mt-4">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          onUpload={upload}
          onSubmit={submit}
          placeholder={t('issue.comments.placeholder')}
          minRows={3}
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={!draft.trim() || send.isPending}
          >
            {t('issue.comments.send')} <span className="arrow">→</span>
          </button>
        </div>
      </div>
    </section>
  );
}
