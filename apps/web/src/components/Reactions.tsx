import { type Comment, QUICK_REACTIONS } from '@ordo/shared';
import { SmilePlus } from 'lucide-react';
import { useToggleReaction } from '../api/queries.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Popover } from './ui/Popover.tsx';

const MORE_REACTIONS = [
  '✅',
  '❌',
  '⚠️',
  '🔥',
  '💯',
  '🙏',
  '👏',
  '💪',
  '🤔',
  '😅',
  '😂',
  '😍',
  '🥳',
  '😢',
  '😬',
  '🙈',
  '🐛',
  '💡',
  '📌',
  '⏳',
  '🧪',
  '🛠️',
  '📦',
  '🎯',
  '☕',
  '🍕',
  '🌈',
  '⭐',
  '💀',
  '🤝',
  '👋',
  '🫡',
];

/** The emoji under a comment, each a toggle for your own reaction, plus a button to add one. */
export function ReactionBar({ comment, issueId }: { comment: Comment; issueId: string }) {
  const ws = useWorkspace();
  const toggle = useToggleReaction(ws.slug, issueId, ws.me.id);
  if (comment.reactions.length === 0) return null;
  const who = (ids: string[]) =>
    ids
      .map((id) => (id === ws.me.id ? 'You' : (ws.memberById.get(id)?.name ?? 'Former member')))
      .join(', ');
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {comment.reactions.map((r) => {
        const mine = r.userIds.includes(ws.me.id);
        return (
          <button
            key={r.emoji}
            type="button"
            className="reaction"
            data-mine={mine}
            aria-pressed={mine}
            title={`${who(r.userIds)} reacted with ${r.emoji}`}
            onClick={() => toggle.mutate({ commentId: comment.id, emoji: r.emoji, on: !mine })}
          >
            <span>{r.emoji}</span>
            <span className="reaction-count">{r.userIds.length}</span>
          </button>
        );
      })}
      <ReactionPicker comment={comment} issueId={issueId} compact />
    </div>
  );
}

/** A smiley button that opens the emoji grid; picking toggles your reaction. */
export function ReactionPicker({
  comment,
  issueId,
  compact,
}: {
  comment: Comment;
  issueId: string;
  compact?: boolean;
}) {
  const ws = useWorkspace();
  const toggle = useToggleReaction(ws.slug, issueId, ws.me.id);
  const mine = new Set(
    comment.reactions.filter((r) => r.userIds.includes(ws.me.id)).map((r) => r.emoji),
  );
  return (
    <Popover
      placement="bottom-end"
      width={264}
      trigger={
        <button
          type="button"
          className={
            compact
              ? 'reaction text-index hover:text-text'
              : 'flex h-6 w-6 items-center justify-center text-index hover:text-text'
          }
          aria-label="Add reaction"
          title="Add reaction"
        >
          <SmilePlus size={compact ? 13 : 14} />
        </button>
      }
    >
      {(close) => (
        <div className="p-2">
          {[QUICK_REACTIONS, MORE_REACTIONS].map((set, i) => (
            <div
              key={set[0]}
              className={`grid grid-cols-8 ${i ? 'mt-1.5 border-t border-border-soft pt-1.5' : ''}`}
            >
              {set.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="flex h-7 w-7 items-center justify-center text-[16px] hover:bg-bg data-[mine=true]:bg-bg data-[mine=true]:outline data-[mine=true]:outline-1 data-[mine=true]:outline-primary"
                  data-mine={mine.has(emoji)}
                  aria-label={emoji}
                  onClick={() => {
                    toggle.mutate({ commentId: comment.id, emoji, on: !mine.has(emoji) });
                    close();
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}
