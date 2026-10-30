import type { SiteInvite } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Send, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { useConfig } from '../../api/queries.ts';
import { t } from '../../i18n/index.ts';
import { relativeTime, shortDate } from '../../lib/format.ts';

import { Card, errMsg } from './ui.tsx';

const splitEmails = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);

/** Invites to the instance itself: an account, no workspace. */
export function Invites() {
  const qc = useQueryClient();
  const config = useConfig();
  const { data = [] } = useQuery({
    queryKey: ['admin', 'invites'],
    queryFn: () => api.get<SiteInvite[]>('/admin/invites'),
  });
  const [emails, setEmails] = useState('');
  const [canCreate, setCanCreate] = useState(false);
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const reload = () => qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
  const copy = (url: string) => {
    navigator.clipboard?.writeText(url);
    toast.success(t('admin.invites.copied'));
  };
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const list = splitEmails(emails);
      const rows = await api.post<SiteInvite[]>('/admin/invites', {
        emails: list.length ? list : undefined,
        canCreateWorkspaces: canCreate,
        expiresInDays: days,
      });
      setEmails('');
      reload();
      // A link has to be passed on by hand; copy it right away. New invites always carry it.
      if (rows.length === 1 && (!rows[0]!.email || !config.data?.emailEnabled)) copy(rows[0]!.url!);
      else toast.success(t('admin.invites.created', { count: rows.length }));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title={t('admin.invites.newTitle')} description={t('admin.invites.description')}>
        <form onSubmit={create}>
          <label className="mb-3 block">
            <span className="section-label mb-1 block">{t('admin.invites.emails')}</span>
            <textarea
              className="input min-h-[4.5rem] py-2"
              value={emails}
              placeholder="ada@example.com, grace@example.com"
              onChange={(e) => setEmails(e.target.value)}
            />
            <span className="mt-1 block text-[12px] text-index">
              {config.data?.emailEnabled
                ? t('admin.invites.emailsHint')
                : t('admin.invites.emailsHintNoEmail')}
            </span>
          </label>
          <label className="flex items-center justify-between border-b border-border-soft py-3 text-[13.5px]">
            <span>
              {t('admin.invites.canCreate')}
              <span className="block text-[12px] text-index">
                {t('admin.invites.canCreateHint')}
              </span>
            </span>
            <input
              type="checkbox"
              className="accent-primary"
              checked={canCreate}
              onChange={(e) => setCanCreate(e.target.checked)}
            />
          </label>
          <label className="mb-4 flex items-center justify-between py-3 text-[13.5px]">
            <span>{t('admin.invites.expires')}</span>
            <select
              className="input w-40"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[1, 7, 14, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {t('admin.invites.days', { count: d })}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {splitEmails(emails).length ? t('admin.invites.send') : t('admin.invites.createLink')}
          </button>
        </form>
      </Card>
      <Card title={t('admin.invites.openTitle')}>
        {data.length === 0 && <p className="text-[13px] text-muted">{t('admin.invites.none')}</p>}
        {data.map((i) => (
          <div key={i.id} className="flex items-center gap-3 border-b border-border-soft py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px]">
                {i.email ?? t('admin.invites.openLink')}
                {i.canCreateWorkspaces && (
                  <span className="tag font-mono">{t('admin.invites.canCreateTag')}</span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-index">
                {[
                  i.createdByName && t('admin.invites.by', { name: i.createdByName }),
                  i.lastSentAt && t('admin.invites.sent', { time: relativeTime(i.lastSentAt) }),
                  t('admin.invites.expiresOn', { date: shortDate(i.expiresAt) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            {i.url && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title={t('admin.invites.copy')}
                aria-label={t('admin.invites.copy')}
                onClick={() => copy(i.url!)}
              >
                <Copy size={12} />
              </button>
            )}
            {i.email && config.data?.emailEnabled && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title={t('admin.invites.resend')}
                aria-label={t('admin.invites.resendTo', { email: i.email })}
                onClick={() =>
                  act(() => api.post(`/admin/invites/${i.id}/resend`), t('admin.invites.resent'))
                }
              >
                <Send size={12} />
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger btn-sm"
              title={t('admin.invites.revoke')}
              aria-label={t('admin.invites.revoke')}
              onClick={() =>
                act(() => api.del(`/admin/invites/${i.id}`), t('admin.invites.revoked'))
              }
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </Card>
    </>
  );
}
