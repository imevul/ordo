import type { InboxFilter, Notification, NotificationType } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlarmClock, AlarmClockOff, CheckCheck, SlidersHorizontal, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, wsPath } from '../api/client.ts';
import { keys, useIssue, useNotificationCounts, useNotifications } from '../api/queries.ts';
import { advancedCount, InboxFilterModal } from '../components/InboxFilterModal.tsx';
import { IssueDetailView } from '../components/IssueDetailView.tsx';
import { StatusIcon } from '../components/icons.tsx';
import { EmptyState, PageHeader, Sep, Spinner } from '../components/PageHeader.tsx';
import { ActorName } from '../components/ui/ActorName.tsx';
import { Avatar } from '../components/ui/Avatar.tsx';
import { Popover } from '../components/ui/Popover.tsx';
import { getLocale, INTL_TAG, t, tx } from '../i18n/index.ts';
import { relativeTime } from '../lib/format.ts';
import { useHotkey } from '../lib/hotkeys.ts';
import { withKept } from '../lib/inbox.ts';
import { readPref, writePref } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';

/** The quick filters: each picks the kinds of notification shown. The modal's kinds apply under All. */
const QUICK = {
  all: undefined,
  mentions: ['issue_mention'],
  assigned: ['issue_assigned', 'issue_unassigned'],
  comments: ['issue_comment'],
} satisfies Record<string, NotificationType[] | undefined>;
type Quick = keyof typeof QUICK;
const QUICK_KEYS = Object.keys(QUICK) as Quick[];

interface InboxView {
  quick: Quick;
  unread: boolean;
  advanced: InboxFilter;
}
const DEFAULT_VIEW: InboxView = { quick: 'all', unread: false, advanced: {} };

const quickChip = (on: boolean) =>
  `flex h-6 items-center gap-1 px-1.5 font-mono text-[10.5px] tracking-[0.08em] uppercase ${
    on ? 'bg-primary text-on-primary' : 'text-muted hover:text-text'
  }`;

function effectiveFilter(v: InboxView): InboxFilter {
  return {
    ...v.advanced,
    types: QUICK[v.quick] ?? v.advanced.types,
    unread: v.unread || undefined,
  };
}

/** The notification's line: `actor` (a name) and what they did, as one sentence. */
function describe(n: Notification, actor: ReactNode, stateName: (id: string) => string) {
  switch (n.type) {
    case 'issue_assigned':
      return tx('inbox.describe.assigned', { actor });
    case 'issue_unassigned':
      return tx('inbox.describe.unassigned', { actor });
    case 'issue_comment':
      return tx('inbox.describe.comment', { actor });
    case 'issue_mention':
      return tx('inbox.describe.mention', { actor });
    case 'issue_status_changed':
      return tx('inbox.describe.statusChanged', {
        actor,
        status: stateName(String(n.data.to ?? '')),
      });
    case 'issue_priority_urgent':
      return tx('inbox.describe.urgent', { actor });
    case 'issue_sla_breached':
      return tx('inbox.describe.slaBreached', { actor });
    case 'comment_reaction':
      return tx('inbox.describe.reaction', { actor, emoji: String(n.data.emoji ?? '') });
  }
}

/** "Mon 09:00": when a snooze ends, in the reader's language. */
const snoozeTime = (d: Date) =>
  d.toLocaleString(INTL_TAG[getLocale()], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

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
    { label: t('inbox.snooze.inAnHour'), until: new Date(now.getTime() + 3_600_000) },
    { label: t('inbox.snooze.laterToday'), until: new Date(now.getTime() + 3 * 3_600_000) },
    { label: t('inbox.snooze.tomorrowMorning'), until: at(1, 9) },
    { label: t('inbox.snooze.nextWeek'), until: at(toMonday, 9) },
  ];
}

export function InboxPage() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [view, setViewState] = useState<InboxView>(() => {
    const stored = readPref<Partial<InboxView>>('inbox.view', {});
    return {
      ...DEFAULT_VIEW,
      ...stored,
      quick: stored.quick && stored.quick in QUICK ? stored.quick : 'all',
    };
  });
  const setView = (patch: Partial<InboxView>) => {
    const next = { ...view, ...patch };
    setViewState(next);
    writePref('inbox.view', next);
    setSelectedId(null);
    setKept({});
  };
  const [filterOpen, setFilterOpen] = useState(false);
  const filter = effectiveFilter(view);
  const { data, isLoading } = useNotifications(ws.slug, showSnoozed, filter);
  const counts = useNotificationCounts(ws.slug).data ?? {};
  const countOf = (q: Quick) =>
    (QUICK[q] ?? (Object.keys(counts) as NotificationType[])).reduce(
      (sum, type) => sum + (counts[type] ?? 0),
      0,
    );
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Opened under the unread filter: still shown, though now read, until the view changes.
  const [kept, setKept] = useState<Record<string, Notification>>({});
  const forget = (ids: string[]) =>
    setKept((k) => Object.fromEntries(Object.entries(k).filter(([id]) => !ids.includes(id))));
  const list = withKept(data ?? [], kept, showSnoozed);
  const selected = list.find((n) => n.id === selectedId) ?? null;
  const issue = useIssue(ws.slug, selected?.issueId ?? undefined);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.notifications(ws.slug) });
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
  };
  const markRead = async (ids?: string[], unread = false) => {
    const readAt = unread ? null : new Date().toISOString();
    setKept((k) =>
      Object.fromEntries(
        Object.entries(k).map(([id, n]) => [id, !ids || ids.includes(id) ? { ...n, readAt } : n]),
      ),
    );
    await api.post(
      wsPath(ws.slug, '/notifications/read'),
      ids ? { ids, unread } : { filter, snoozed: showSnoozed },
    );
    refresh();
  };
  const snooze = async (ids: string[], until: Date | null) => {
    await api.post(wsPath(ws.slug, '/notifications/snooze'), {
      ids,
      until: until?.toISOString() ?? null,
    });
    if (ids.includes(selectedId ?? '')) setSelectedId(null);
    forget(ids);
    setSnoozeOpen(false);
    refresh();
  };
  const remove = async (body: { ids?: string[]; read?: boolean }) => {
    await api.post(
      wsPath(ws.slug, '/notifications/delete'),
      body.ids ? body : { ...body, filter, snoozed: showSnoozed },
    );
    if (body.ids?.includes(selectedId ?? '')) setSelectedId(null);
    if (body.ids) forget(body.ids);
    else setKept({});
    refresh();
  };

  const open = (n: Notification) => {
    setSelectedId(n.id);
    if (view.unread) setKept((k) => ({ ...k, [n.id]: n }));
    if (!n.readAt) markRead([n.id]);
  };

  const idx = list.findIndex((n) => n.id === selectedId);
  useHotkey(['j', 'arrowdown'], () => list[idx + 1] && open(list[idx + 1]!));
  useHotkey(['k', 'arrowup'], () => idx > 0 && open(list[idx - 1]!));
  useHotkey('u', () => selected && markRead([selected.id], !!selected.readAt));
  useHotkey(['backspace', 'delete'], () => selected && remove({ ids: [selected.id] }));
  useHotkey(
    QUICK_KEYS.map((_, i) => String(i + 1)),
    (e) => setView({ quick: QUICK_KEYS[Number(e.key) - 1]! }),
  );
  useHotkey(String(QUICK_KEYS.length + 1), () => setView({ unread: !view.unread }));
  useHotkey('shift+f', () => setFilterOpen(true));
  const unreadShown = list.filter((n) => !n.readAt).length;
  const readShown = list.length - unreadShown;
  const advanced = advancedCount(view.advanced);
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
              {t('inbox.kicker')}
            </>
          }
          title={showSnoozed ? t('inbox.snoozedTitle') : t('inbox.title')}
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
                      title={t('inbox.snooze.buttonTitle')}
                      aria-label={t('inbox.snooze.button')}
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
                            {snoozeTime(c.until)}
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
                  title={t('inbox.snooze.unsnoozeTitle')}
                >
                  <AlarmClockOff size={13} />
                </button>
              )}
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${advanced ? 'text-primary' : ''}`}
                onClick={() => setFilterOpen(true)}
                title={t('inbox.filter.buttonTitle')}
                aria-label={t('inbox.filter.title')}
              >
                <SlidersHorizontal size={13} />
                {advanced > 0 && <span className="font-mono text-[10.5px]">{advanced}</span>}
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${showSnoozed ? 'text-primary' : ''}`}
                onClick={() => {
                  setShowSnoozed(!showSnoozed);
                  setSelectedId(null);
                  setKept({});
                }}
                aria-pressed={showSnoozed}
                title={showSnoozed ? t('inbox.backToInbox') : t('inbox.showSnoozed')}
              >
                <AlarmClock size={13} />
                <span className="hidden lg:inline">
                  {showSnoozed ? t('inbox.title') : t('inbox.snoozedTitle')}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => markRead()}
                disabled={unreadShown === 0}
                title={t('inbox.markShownRead', { count: unreadShown })}
                aria-label={t('inbox.markShownRead', { count: unreadShown })}
              >
                <CheckCheck size={13} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  // Under the unread filter the server matches no read ones; the read ones shown are those kept.
                  view.unread
                    ? remove({ ids: list.filter((n) => n.readAt).map((n) => n.id) })
                    : remove({ read: true })
                }
                disabled={readShown === 0}
                title={t('inbox.deleteShownRead', { count: readShown })}
                aria-label={t('inbox.deleteShownRead', { count: readShown })}
              >
                <Trash2 size={13} />
              </button>
            </>
          }
        />
        <div className="flex flex-none flex-wrap items-center gap-1 border-b border-border-soft px-3 py-1.5">
          {QUICK_KEYS.map((q, i) => {
            const count = countOf(q);
            return (
              <button
                key={q}
                type="button"
                className={quickChip(view.quick === q)}
                aria-pressed={view.quick === q}
                title={t('inbox.quick.title', { key: i + 1 })}
                onClick={() => setView({ quick: q })}
              >
                {t(`inbox.quick.${q}`)}
                {count > 0 && <span className="opacity-70">{count}</span>}
              </button>
            );
          })}
          <button
            type="button"
            className={quickChip(view.unread)}
            aria-pressed={view.unread}
            title={t('inbox.quick.title', { key: QUICK_KEYS.length + 1 })}
            onClick={() => setView({ unread: !view.unread })}
          >
            {t('inbox.quick.unread')}
          </button>
        </div>
        <InboxFilterModal
          open={filterOpen}
          onClose={() => setFilterOpen(false)}
          filter={view.advanced}
          kindFromQuick={view.quick !== 'all'}
          onChange={(advanced) => setView({ advanced })}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading && <Spinner />}
          {!isLoading && list.length === 0 && (
            <EmptyState
              title={
                showSnoozed
                  ? t('inbox.empty.snoozedTitle')
                  : view.quick !== 'all' || view.unread || advanced
                    ? t('inbox.empty.filteredTitle')
                    : t('inbox.empty.title')
              }
              body={
                showSnoozed
                  ? t('inbox.empty.snoozedBody')
                  : view.quick !== 'all' || view.unread || advanced
                    ? t('inbox.empty.filteredBody')
                    : t('inbox.empty.body')
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
                      status={actor.status}
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
                        ? t('inbox.snoozedUntil', { time: snoozeTime(new Date(n.snoozedUntil)) })
                        : relativeTime(n.createdAt)}
                    </span>
                  </span>
                  <span
                    className={`mt-0.5 block truncate text-[13.5px] ${n.readAt ? 'text-muted' : 'font-medium text-text'}`}
                  >
                    {n.issue?.title ?? t('inbox.deletedIssue')}
                  </span>
                  <span className="block truncate text-[12.5px] text-index">
                    {describe(
                      n,
                      <ActorName person={actor} className="" />,
                      (id) => ws.stateById.get(id)?.name ?? t('inbox.newStatus'),
                    )}
                  </span>
                </span>
                {!n.readAt && (
                  <span
                    className="mt-2 h-[7px] w-[7px] flex-none bg-primary shadow-[0_0_10px_var(--color-primary)]"
                    title={t('inbox.unread')}
                  >
                    <span className="sr-only">{t('inbox.unread')}</span>
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
              {t('inbox.back')}
            </button>
            <div className="min-h-0 flex-1">
              <IssueDetailView
                key={issue.data.id}
                issue={issue.data}
                compact
                focusCommentId={selected.commentId}
              />
            </div>
          </div>
        ) : selected && issue.isLoading ? (
          <Spinner />
        ) : (
          <div className="hud-ground flex h-full">
            <EmptyState title={t('inbox.select.title')} body={t('inbox.select.body')} />
          </div>
        )}
      </div>
    </div>
  );
}
