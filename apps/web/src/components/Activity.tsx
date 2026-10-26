import type { Comment, HistoryChange, HistoryEntry, IssueDetail } from '@ordo/shared';
import { estimateLabel, priorityLabel } from '@ordo/shared';
import { MoreHorizontal, Reply } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import {
  keys,
  useAttachmentUpload,
  useComments,
  useHistory,
  useWsMutation,
} from '../api/queries.ts';
import { longDate, relativeTime, shortDate } from '../lib/format.ts';
import { cycleName, useWorkspace } from '../lib/workspace.tsx';
import { PriorityIcon, StatusIcon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { MarkdownEditor } from './MarkdownEditor.tsx';
import { ReactionBar, ReactionPicker } from './Reactions.tsx';
import { ActorName } from './ui/ActorName.tsx';
import { Avatar } from './ui/Avatar.tsx';
import { Popover } from './ui/Popover.tsx';

function ChangeText({
  c,
  actorId,
  issue,
}: {
  c: HistoryChange;
  actorId: string | null;
  issue: IssueDetail;
}) {
  const ws = useWorkspace();
  const name = (id: unknown) =>
    typeof id === 'string' ? (ws.memberById.get(id)?.name ?? 'someone') : 'nobody';
  const strong = (x: ReactNode) => <span className="text-text">{x}</span>;
  switch (c.field) {
    case 'created':
      return <>created the issue</>;
    case 'deleted':
      return <>moved the issue to trash</>;
    case 'restored':
      return <>restored the issue</>;
    case 'state': {
      const s = ws.stateById.get(c.to as string);
      return (
        <>
          changed status to{' '}
          {s ? (
            <span className="inline-flex items-center gap-1 align-[-2px] text-text">
              <StatusIcon type={s.type} color={s.color} size={12} /> {s.name}
            </span>
          ) : (
            strong('another status')
          )}
        </>
      );
    }
    case 'assignee':
      if (!c.to) return <>removed assignee {strong(name(c.from))}</>;
      if (c.to === actorId) return <>self-assigned the issue</>;
      return <>assigned the issue to {strong(name(c.to))}</>;
    case 'priority':
      return (
        <>
          set priority to{' '}
          <span className="inline-flex items-center gap-1 align-[-2px] text-text">
            <PriorityIcon priority={c.to as number} size={12} /> {priorityLabel(c.to as number)}
          </span>
        </>
      );
    case 'title':
      return <>changed the title to {strong(`"${c.to}"`)}</>;
    case 'description':
      return <>updated the description</>;
    case 'labels': {
      const from = (c.from as string[]) ?? [];
      const to = (c.to as string[]) ?? [];
      const added = to
        .filter((l) => !from.includes(l))
        .map((l) => ws.labelById.get(l)?.name ?? 'label');
      const removed = from
        .filter((l) => !to.includes(l))
        .map((l) => ws.labelById.get(l)?.name ?? 'label');
      return (
        <>
          {added.length > 0 && <>added {strong(added.join(', '))}</>}
          {added.length > 0 && removed.length > 0 && ' and '}
          {removed.length > 0 && <>removed {strong(removed.join(', '))}</>}
        </>
      );
    }
    case 'project':
      return c.to ? (
        <>added to project {strong(ws.projectById.get(c.to as string)?.name ?? 'a project')}</>
      ) : (
        <>removed from project</>
      );
    case 'cycle': {
      const cy = c.to ? ws.cycleById.get(c.to as string) : null;
      return c.to ? (
        <>added to {strong(cy ? cycleName(cy) : 'a cycle')}</>
      ) : (
        <>removed from cycle</>
      );
    }
    case 'parent':
      return c.to ? (
        <>made this a sub-issue{issue.parent ? <> of {strong(issue.parent.identifier)}</> : null}</>
      ) : (
        <>removed the parent issue</>
      );
    case 'estimate': {
      const team = ws.teamById.get(issue.teamId);
      return c.to == null ? (
        <>removed the estimate</>
      ) : (
        <>
          set estimate to {strong(estimateLabel(team?.estimateScale ?? 'linear', c.to as number))}
        </>
      );
    }
    case 'dueDate':
      return c.to ? (
        <>set due date to {strong(shortDate(c.to as string))}</>
      ) : (
        <>removed the due date</>
      );
    case 'team':
      return (
        <>
          moved from {strong(ws.teamById.get(c.from as string)?.name ?? 'another team')} to{' '}
          {strong(ws.teamById.get(c.to as string)?.name ?? 'a team')}
        </>
      );
    default:
      return <>changed {c.field}</>;
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
            <ActorName person={actor} /> <ChangeText c={c} actorId={entry.actorId} issue={issue} />
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
}: {
  comment: Comment;
  replies: Comment[];
  issueId: string;
}) {
  const ws = useWorkspace();
  const upload = useAttachmentUpload(ws.slug, issueId);
  const author = comment.authorId ? ws.memberById.get(comment.authorId) : undefined;
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const inv = [keys.comments(ws.slug, issueId) as unknown as unknown[]];
  const save = useWsMutation(
    ws.slug,
    (b: string) => api.patch(wsPath(ws.slug, `/comments/${comment.id}`), { body: b }),
    { invalidate: inv },
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/comments/${comment.id}`)), {
    invalidate: inv,
  });
  const sendReply = useWsMutation(
    ws.slug,
    (b: string) =>
      api.post(wsPath(ws.slug, `/issues/${issueId}/comments`), { body: b, parentId: comment.id }),
    {
      invalidate: inv,
    },
  );
  const mine = comment.authorId === ws.me.id;

  return (
    <div className="panel panel-sm my-2">
      <div className="p-3.5">
        <div className="flex items-center gap-2 text-[12.5px]">
          {author && (
            <Avatar
              name={author.name}
              color={author.avatarColor}
              src={author.avatarUrl}
              size={18}
            />
          )}
          <ActorName person={author} fallback="Former member" className="font-medium" />
          <span className="text-index" title={longDate(comment.createdAt)}>
            {relativeTime(comment.createdAt)}
            {comment.editedAt && ' · edited'}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <ReactionPicker comment={comment} issueId={issueId} />
            {!comment.parentId && (
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
                onClick={() => setReplying(true)}
                aria-label="Reply"
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
                    aria-label="Comment actions"
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
                        Edit
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
                      Delete
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
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    save.mutate(body);
                    setEditing(false);
                  }}
                >
                  Save
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
            <CommentItem key={r.id} comment={r} replies={[]} issueId={issueId} />
          ))}
          {replying && (
            <div className="pt-2">
              <MarkdownEditor
                value={reply}
                onChange={setReply}
                onUpload={upload}
                autoFocus
                minRows={2}
                placeholder="Leave a reply…"
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

export function Activity({ issue }: { issue: IssueDetail }) {
  const ws = useWorkspace();
  const { data: history = [] } = useHistory(ws.slug, issue.id);
  const { data: comments = [] } = useComments(ws.slug, issue.id);
  const [draft, setDraft] = useState('');
  const upload = useAttachmentUpload(ws.slug, issue.id);
  const send = useWsMutation(
    ws.slug,
    (body: string) => api.post(wsPath(ws.slug, `/issues/${issue.id}/comments`), { body }),
    {
      invalidate: [keys.comments(ws.slug, issue.id) as unknown as unknown[]],
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

  const submit = () => {
    if (!draft.trim()) return;
    send.mutate(draft);
    setDraft('');
  };

  return (
    <section className="mt-10">
      <div className="section-label mb-3">Activity</div>
      {items.map((it) =>
        it.kind === 'h' ? (
          <HistoryItem key={it.h.id} entry={it.h} issue={issue} />
        ) : (
          <CommentItem
            key={it.c.id}
            comment={it.c}
            replies={comments.filter((r) => r.parentId === it.c.id)}
            issueId={issue.id}
          />
        ),
      )}
      <div className="mt-4">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          onUpload={upload}
          onSubmit={submit}
          placeholder="Leave a comment…  (⌘/Ctrl+Enter to send)"
          minRows={3}
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={!draft.trim() || send.isPending}
          >
            Comment <span className="arrow">→</span>
          </button>
        </div>
      </div>
    </section>
  );
}
