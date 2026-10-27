import type { Notification } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlarmClock, AlarmClockOff, CheckCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { keys, useIssue, useNotifications } from '../api/queries.ts';
import { IssueDetailView } from '../components/IssueDetailView.tsx';
import { StatusIcon } from '../components/icons.tsx';
import { EmptyState, PageHeader, Sep, Spinner } from '../components/PageHeader.tsx';
import { ActorName } from '../components/ui/ActorName.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { Popover } from '../components/ui/Popover.tsx';
import { relativeTime } from '../lib/format.ts';
import { useHotkey } from '../lib/hotkeys.ts';
import { useWorkspace } from '../lib/workspace.tsx';

function describe(n: Notification, stateName: (id: string) => string) {
  switch (n.type) {
    case 'issue_assigned':
      return 'assigned you';
    case 'issue_unassigned':
      return 'unassigned you';
    case 'issue_comment':
      return 'commented';
    case 'issue_mention':
      return 'mentioned you';
    case 'issue_status_changed':
      return `changed status to ${stateName(String(n.data.to ?? ''))}`;
    case 'issue_priority_urgent':
      return 'marked as urgent';
    case 'issue_sla_breached':
      return 'missed its SLA';
    case 'comment_reaction':
      return `reacted ${String(n.data.emoji ?? '')} to your comment`;
  }
}

/** When "snooze until …" ends, in the viewer's local time. */
function snoozeChoices(now = new Date()) {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { label: 'In an hour', until: new Date(now.getTime() + 3_600_000) },
    { label: 'Later today', until: new Date(now.getTime() + 3 * 3_600_000) },
    { label: 'Tomorrow morning', until: at(1, 9) },
    { label: 'Next week', until: at(toMonday, 9) },
  ];
}

export function InboxPage() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [showSnoozed, setShowSnoozed] = useState(false);
  const { data, isLoading } = useNotifications(ws.slug, showSnoozed);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = data ?? [];
  const selected = list.find((n) => n.id === selectedId) ?? null;
  const issue = useIssue(ws.slug, selected?.issueId ?? undefined);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.notifications(ws.slug) });
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
  };
  const markRead = async (ids?: string[], unread = false) => {
    await api.post(wsPath(ws.slug, '/notifications/read'), { ids, unread });
    refresh();
  };
  const snooze = async (ids: string[], until: Date | null) => {
    await api.post(wsPath(ws.slug, '/notifications/snooze'), {
      ids,
      until: until?.toISOString() ?? null,
    });
    if (ids.includes(selectedId ?? '')) setSelectedId(null);
    setSnoozeOpen(false);
    refresh();
  };
  const remove = async (body: { ids?: string[]; read?: boolean }) => {
    await api.post(wsPath(ws.slug, '/notifications/delete'), body);
    if (body.ids?.includes(selectedId ?? '')) setSelectedId(null);
    refresh();
  };

  const open = (n: Notification) => {
    setSelectedId(n.id);
    if (!n.readAt) markRead([n.id]);
  };

  const idx = list.findIndex((n) => n.id === selectedId);
  useHotkey(['j', 'arrowdown'], () => list[idx + 1] && open(list[idx + 1]!));
  useHotkey(['k', 'arrowup'], () => idx > 0 && open(list[idx - 1]!));
  useHotkey('u', () => selected && markRead([selected.id], !!selected.readAt));
  useHotkey(['backspace', 'delete'], () => selected && remove({ ids: [selected.id] }));
  useHotkey('h', () => {
    if (!selected) return;
    if (showSnoozed) snooze([selected.id], null);
    else setSnoozeOpen(true);
  });

  return (
    <div className="flex h-full min-h-0">
      <div
        className={`flex min-h-0 w-full flex-none flex-col border-r border-border-soft md:w-[380px] ${selected ? 'hidden md:flex' : 'flex'}`}
      >
        <PageHeader
          kicker={
            <>
              {ws.workspace.name}
              <Sep />
              inbox
            </>
          }
          title={showSnoozed ? 'Snoozed' : 'Inbox'}
          actions={
            <>
              {selected && !showSnoozed && (
                <Popover
                  open={snoozeOpen}
                  onOpenChange={setSnoozeOpen}
                  placement="bottom-end"
                  width={220}
                  trigger={
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      title="Snooze (H)"
                      aria-label="Snooze"
                    >
                      <AlarmClock size={13} />
                    </button>
                  }
                >
                  {() => (
                    <div className="py-1">
                      {snoozeChoices().map((c) => (
                        <button
                          type="button"
                          key={c.label}
                          className="menu-item"
                          onClick={() => snooze([selected.id], c.until)}
                        >
                          {c.label}
                          <span className="ml-auto font-mono text-[10.5px] text-index">
                            {c.until.toLocaleString(undefined, {
                              weekday: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </Popover>
              )}
              {selected && showSnoozed && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => snooze([selected.id], null)}
                  title="Unsnooze (H)"
                >
                  <AlarmClockOff size={13} />
                </button>
              )}
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${showSnoozed ? 'text-primary' : ''}`}
                onClick={() => {
                  setShowSnoozed(!showSnoozed);
                  setSelectedId(null);
                }}
                aria-pressed={showSnoozed}
                title={showSnoozed ? 'Back to the inbox' : 'Show snoozed'}
              >
                <AlarmClock size={13} />
                <span className="hidden lg:inline">{showSnoozed ? 'Inbox' : 'Snoozed'}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => markRead()}
                title="Mark all as read"
                aria-label="Mark all as read"
              >
                <CheckCheck size={13} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => remove({ read: true })}
                title="Delete read notifications"
                aria-label="Delete read notifications"
              >
                <Trash2 size={13} />
              </button>
            </>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading && <Spinner />}
          {!isLoading && list.length === 0 && (
            <EmptyState
              title={showSnoozed ? 'nothing snoozed' : 'all caught up'}
              body={
                showSnoozed
                  ? 'Snoozed notifications wait here and come back unread when it’s time.'
                  : 'Assignments, mentions and comments on issues you follow land here.'
              }
            />
          )}
          {list.map((n) => {
            const actor = n.actorId ? ws.memberById.get(n.actorId) : null;
            const s = n.issue ? ws.stateById.get(n.issue.stateId) : null;
            return (
              <button
                type="button"
                key={n.id}
                onClick={() => open(n)}
                className="row flex w-full items-start gap-3 border-b border-border-soft/60 px-4 py-3 text-left"
                data-selected={selected?.id === n.id}
              >
                <span className="mt-1">
                  {actor ? (
                    <Avatar
                      name={actor.name}
                      color={actor.avatarColor}
                      src={actor.avatarUrl}
                      size={20}
                    />
                  ) : (
                    <span className="block h-5 w-5 bg-border" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    {s && <StatusIcon type={s.type} color={s.color} size={12} />}
                    <span className="font-mono text-[11px] text-index">{n.issue?.identifier}</span>
                    <span className="ml-auto flex-none font-mono text-[10.5px] text-index">
                      {n.snoozedUntil
                        ? `until ${new Date(n.snoozedUntil).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
                        : relativeTime(n.createdAt)}
                    </span>
                  </span>
                  <span
                    className={`mt-0.5 block truncate text-[13.5px] ${n.readAt ? 'text-muted' : 'font-medium text-text'}`}
                  >
                    {n.issue?.title ?? 'Deleted issue'}
                  </span>
                  <span className="block truncate text-[12.5px] text-index">
                    <ActorName person={actor} className="" />{' '}
                    {describe(n, (id) => ws.stateById.get(id)?.name ?? 'a new status')}
                  </span>
                </span>
                {!n.readAt && (
                  <span
                    className="mt-2 h-[7px] w-[7px] flex-none bg-primary shadow-[0_0_10px_var(--color-primary)]"
                    title="Unread"
                  >
                    <span className="sr-only">Unread</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className={`min-w-0 flex-1 ${selected ? 'block' : 'hidden md:block'}`}>
        {selected && issue.data ? (
          <div className="flex h-full flex-col">
            <button
              type="button"
              className="h-9 flex-none border-b border-border-soft px-4 text-left font-mono text-[11px] text-index md:hidden"
              onClick={() => setSelectedId(null)}
            >
              ← back to inbox
            </button>
            <div className="min-h-0 flex-1">
              <IssueDetailView key={issue.data.id} issue={issue.data} compact />
            </div>
          </div>
        ) : selected && issue.isLoading ? (
          <Spinner />
        ) : (
          <div className="hud-ground flex h-full">
            <EmptyState
              title="inbox"
              body="Select a notification to see the issue. J/K to move, U to toggle read, H to snooze, ⌫ to delete."
            />
          </div>
        )}
      </div>
    </div>
  );
}
