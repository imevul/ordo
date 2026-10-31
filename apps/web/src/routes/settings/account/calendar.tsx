import type { CalendarFeed } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Copy, Eye, RefreshCcw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { keys, useCalendarFeeds } from '../../../api/queries.ts';
import { confirmDialog, Modal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { relativeTime } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { errMsg } from './shared.ts';

/**
 * Creates the personal feed (no view) or a view's feed, after confirming when it replaces one:
 * only a hash is stored, so a new URL is the only way to see it again. Resolves to the URL.
 */
function useCreateFeed() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const { data: feeds = [] } = useCalendarFeeds(ws.slug);
  return async (viewId: string | null): Promise<string | null> => {
    if (
      feeds.some((f) => f.viewId === viewId) &&
      !(await confirmDialog({
        title: t('settings.calendar.replaceTitle'),
        body: t('settings.calendar.replaceBody'),
        confirmLabel: t('settings.calendar.replaceConfirm'),
        danger: true,
      }))
    )
      return null;
    try {
      const res = await api.post<{ feed: CalendarFeed; url: string }>(
        wsPath(ws.slug, '/calendar-feeds'),
        { viewId },
      );
      qc.invalidateQueries({ queryKey: keys.calendarFeeds(ws.slug) });
      return res.url;
    } catch (err) {
      toast.error(errMsg(err));
      return null;
    }
  };
}

/** A freshly made feed URL: copy it, or hand it to the calendar app through webcal://. */
function FeedUrl({ url }: { url: string }) {
  return (
    <div className="panel panel-sm mb-5 p-4 [--panel-border:var(--color-primary)]">
      <div className="kicker mb-2">{t('settings.calendar.copyNow')}</div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 basis-60 truncate font-mono text-[12.5px]">{url}</code>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            navigator.clipboard?.writeText(url);
            toast.success(t('common.copied'));
          }}
        >
          <Copy size={12} /> {t('common.copy')}
        </button>
        <a className="btn btn-ghost btn-sm" href={url.replace(/^https?:/, 'webcal:')}>
          <CalendarDays size={12} /> {t('settings.calendar.openInApp')}
        </a>
      </div>
    </div>
  );
}

function FeedRow({ feed, label }: { feed: CalendarFeed; label: string }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const revoke = async () => {
    if (
      !(await confirmDialog({
        title: t('settings.calendar.revokeTitle'),
        body: t('settings.calendar.revokeBody'),
        confirmLabel: t('settings.calendar.revokeConfirm'),
        danger: true,
      }))
    )
      return;
    try {
      await api.del(wsPath(ws.slug, `/calendar-feeds/${feed.id}`));
    } catch (err) {
      toast.error(errMsg(err));
    }
    // Refetch either way: a 404 means it was already revoked elsewhere.
    qc.invalidateQueries({ queryKey: keys.calendarFeeds(ws.slug) });
  };
  return (
    <div className="flex h-11 items-center gap-3 border-b border-border-soft">
      {feed.viewId ? (
        <Eye size={14} className="text-muted" />
      ) : (
        <CalendarDays size={14} className="text-muted" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="hidden font-mono text-[11.5px] text-index sm:inline">{feed.prefix}…</span>
      <span className="min-w-24 flex-none text-right font-mono text-[11px] text-index">
        {feed.lastUsedAt
          ? t('settings.calendar.used', { time: relativeTime(feed.lastUsedAt) })
          : t('settings.calendar.neverUsed')}
      </span>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={revoke}
        aria-label={t('settings.calendar.revokeFeed', { name: label })}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/** Account → Calendar: the personal feed, and feeds of saved views. */
export function CalendarSection() {
  const ws = useWorkspace();
  const { data: feeds = [] } = useCalendarFeeds(ws.slug);
  const create = useCreateFeed();
  const [created, setCreated] = useState<{ viewId: string | null; url: string } | null>(null);
  const [viewId, setViewId] = useState('');
  const personal = feeds.find((f) => !f.viewId);
  const viewFeeds = feeds.filter((f) => f.viewId && ws.viewById.has(f.viewId));
  const unsubscribed = ws.views.filter((v) => !feeds.some((f) => f.viewId === v.id));

  const make = async (id: string | null) => {
    const url = await create(id);
    if (url) setCreated({ viewId: id, url });
    return url;
  };
  const subscribe = async (e: FormEvent) => {
    e.preventDefault();
    if (viewId && (await make(viewId))) setViewId('');
  };

  return (
    <>
      <SettingsCard
        title={t('settings.calendar.title')}
        description={t('settings.calendar.description', { workspace: ws.workspace.name })}
      >
        {created && !created.viewId && <FeedUrl url={created.url} />}
        {personal && <FeedRow feed={personal} label={t('settings.calendar.personal')} />}
        <div className="mt-4 flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={() => make(null)}>
            {personal ? <RefreshCcw size={13} /> : <CalendarDays size={13} />}{' '}
            {personal ? t('settings.calendar.reset') : t('settings.calendar.create')}
          </button>
          <span className="text-[12px] text-muted">{t('settings.calendar.secretHint')}</span>
        </div>
      </SettingsCard>
      <SettingsCard
        title={t('settings.calendar.viewsTitle')}
        description={t('settings.calendar.viewsDescription')}
      >
        {unsubscribed.length > 0 && (
          <form onSubmit={subscribe} className="mb-5 flex gap-2">
            <select
              className="input min-w-0 flex-1"
              value={viewId}
              onChange={(e) => setViewId(e.target.value)}
              aria-label={t('settings.calendar.pickView')}
              required
            >
              <option value="">{t('settings.calendar.pickView')}</option>
              {unsubscribed.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button className="btn btn-primary">
              <CalendarDays size={13} /> {t('settings.calendar.subscribe')}
            </button>
          </form>
        )}
        {created?.viewId && <FeedUrl url={created.url} />}
        {viewFeeds.map((f) => (
          <FeedRow key={f.id} feed={f} label={ws.viewById.get(f.viewId!)!.name} />
        ))}
        {viewFeeds.length === 0 && !created?.viewId && (
          <p className="font-mono text-[12px] text-index">
            {ws.views.length ? t('settings.calendar.noViewFeeds') : t('settings.calendar.noViews')}
          </p>
        )}
      </SettingsCard>
    </>
  );
}

/** The "subscribe in a calendar app" button of a saved view. */
export function SubscribeViewButton({ viewId }: { viewId: string }) {
  const create = useCreateFeed();
  const [url, setUrl] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={async () => setUrl(await create(viewId))}
        aria-label={t('settings.calendar.subscribeView')}
        title={t('settings.calendar.subscribeView')}
      >
        <CalendarDays size={13} />
      </button>
      <Modal
        open={!!url}
        onClose={() => setUrl(null)}
        width={560}
        label={t('settings.calendar.subscribeView')}
      >
        <div className="p-5">
          <div className="section-label mb-2">{t('settings.calendar.subscribeView')}</div>
          <p className="mb-4 text-[13px] text-muted">{t('settings.calendar.viewModalBody')}</p>
          {url && <FeedUrl url={url} />}
          <div className="flex justify-end">
            <button type="button" className="btn btn-ghost" onClick={() => setUrl(null)}>
              {t('common.done')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
