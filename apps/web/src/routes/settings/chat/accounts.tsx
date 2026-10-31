import type { ChatService } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing, Copy, Link2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { relativeTime } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { errMsg } from './shared.ts';

// ─── Account → Chat accounts ─────────────────────────────────────────────

/** People link their chat accounts by sending a one-time code from them. */
export function ChatAccountsCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'chat-accounts'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ services: ChatService[] }>(wsPath(ws.slug, '/me/chat-accounts')),
    // Linking happens in the chat app; pick it up when the person comes back.
    refetchOnWindowFocus: true,
  });
  const [codes, setCodes] = useState<Record<string, { code: string; hint: string }>>({});
  if (!data?.services.length) return null;
  const reload = () => qc.invalidateQueries({ queryKey: key });

  return (
    <SettingsCard
      title={t('integrations.chatAccounts.title')}
      description={t('integrations.chatAccounts.description')}
    >
      {data.services.map((s) => {
        const pending = codes[s.integrationId];
        return (
          <div key={s.integrationId} className="border-b border-border-soft py-3">
            <div className="mb-2 flex items-center gap-2 text-[13px]">
              <span className="flex-1">{s.name}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  try {
                    const res = await api.post<{ code: string; hint: string }>(
                      wsPath(ws.slug, `/me/chat-accounts/${s.integrationId}/code`),
                    );
                    setCodes({ ...codes, [s.integrationId]: res });
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <Link2 size={12} />{' '}
                {s.accounts.length
                  ? t('integrations.chatAccounts.linkAnother')
                  : t('integrations.chatAccounts.linkAccount')}
              </button>
            </div>
            {pending && (
              <div className="mb-2 border border-border-soft bg-bg p-3 text-[12.5px]">
                <div className="mb-1 text-muted">
                  {t('integrations.chatAccounts.send', {
                    command: pending.hint.replace('CODE', pending.code),
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[15px] tracking-[0.12em] text-highlight">
                    {pending.code}
                  </code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={t('integrations.chatAccounts.copyCode')}
                    onClick={() => {
                      void navigator.clipboard?.writeText(pending.code);
                      toast.success(t('common.copied'));
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <span className="text-[11.5px] text-index">
                    {t('integrations.chatAccounts.validity')}
                  </span>
                </div>
              </div>
            )}
            {s.accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-2 py-1 text-[12.5px]">
                <span className="flex-1 font-mono">
                  {a.username ?? t('integrations.chatAccounts.linkedAccount')}
                  <span className="ml-2 text-index">
                    {t('integrations.chatAccounts.linkedAgo', { time: relativeTime(a.createdAt) })}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={
                    a.notify
                      ? t('integrations.chatAccounts.notificationsOn')
                      : t('integrations.chatAccounts.notificationsOff')
                  }
                  aria-label={
                    a.notify
                      ? t('integrations.chatAccounts.turnNotificationsOff')
                      : t('integrations.chatAccounts.turnNotificationsOn')
                  }
                  onClick={async () => {
                    await api.patch(wsPath(ws.slug, `/me/chat-accounts/${a.id}`), {
                      notify: !a.notify,
                    });
                    reload();
                  }}
                >
                  {a.notify ? <BellRing size={12} /> : <BellOff size={12} />}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('integrations.chatAccounts.unlink')}
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        title: t('integrations.chatAccounts.confirmUnlinkTitle', {
                          service: s.name,
                        }),
                        body: t('integrations.chatAccounts.confirmUnlinkBody'),
                        confirmLabel: t('integrations.chatAccounts.unlink'),
                        danger: true,
                      }))
                    )
                      return;
                    await api.del(wsPath(ws.slug, `/me/chat-accounts/${a.id}`));
                    reload();
                  }}
                >
                  <Unlink size={12} />
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </SettingsCard>
  );
}
