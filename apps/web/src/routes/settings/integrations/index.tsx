import type { Integration, IntegrationProviderInfo } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GitPullRequest,
  Mail,
  MessageSquare,
  Pencil,
  Plug,
  Power,
  Ticket,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { Spinner } from '../../../components/PageHeader.tsx';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { relativeTime } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { chatForms } from '../chat/index.tsx';
import { SettingsCard } from '../ui.tsx';
import { ConnectModal, EditModal } from './modals.tsx';
import { providerText } from './shared.ts';

export { GitAccountsCard } from './git-accounts.tsx';

export function IntegrationsSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'integrations'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<{ providers: IntegrationProviderInfo[]; integrations: Integration[] }>(
        wsPath(ws.slug, '/integrations'),
      ),
    enabled: ws.isAdmin,
  });
  const [connecting, setConnecting] = useState<IntegrationProviderInfo | null>(null);
  const [editing, setEditing] = useState<Integration | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: key });

  useEffect(() => {
    // The GitHub App flow comes back with ?error= when something went wrong.
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    if (!error) return;
    toast.error(error);
    url.searchParams.delete('error');
    window.history.replaceState(null, '', url);
  }, []);

  if (!ws.isAdmin) return <p className="text-muted">{t('integrations.list.adminsOnly')}</p>;
  if (!data) return <Spinner />;
  const providerName = (k: string) => data.providers.find((p) => p.key === k)?.name ?? k;
  const isChat = (k: string) => data.providers.find((p) => p.key === k)?.category === 'chat';

  return (
    <>
      <SettingsCard title={t('integrations.list.connectedTitle')}>
        {data.integrations.map((i) => (
          <div key={i.id} className="border-b border-border-soft py-3">
            <div className="flex items-center gap-3">
              {i.provider === 'email' ? (
                <Mail
                  size={14}
                  className={`flex-none ${i.status === 'active' ? 'text-highlight' : 'text-index'}`}
                />
              ) : i.provider === 'jira' ? (
                <Ticket
                  size={14}
                  className={`flex-none ${i.status === 'active' ? 'text-highlight' : 'text-index'}`}
                />
              ) : isChat(i.provider) ? (
                <MessageSquare
                  size={14}
                  className={`flex-none ${i.status === 'active' ? 'text-highlight' : 'text-index'}`}
                />
              ) : (
                <GitPullRequest
                  size={14}
                  className={`flex-none ${i.status === 'active' ? 'text-highlight' : 'text-index'}`}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px]">
                  {i.name}
                  <span className="ml-2 text-index">{providerName(i.provider)}</span>
                </div>
                <div className="truncate font-mono text-[11px] text-index">
                  {describe(i)}
                  {i.lastEventAt &&
                    ` · ${t('integrations.list.lastEvent', { time: relativeTime(i.lastEventAt) })}`}
                </div>
              </div>
              <StatusChip status={i.status} />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t('integrations.list.settingsFor', { name: i.name })}
                onClick={() => setEditing(i)}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={
                  i.status === 'disabled'
                    ? t('integrations.list.turnOnName', { name: i.name })
                    : t('integrations.list.turnOffName', { name: i.name })
                }
                title={
                  i.status === 'disabled'
                    ? t('integrations.list.turnOn')
                    : t('integrations.list.turnOff')
                }
                onClick={async () => {
                  await api.patch(wsPath(ws.slug, `/integrations/${i.id}`), {
                    enabled: i.status === 'disabled',
                  });
                  reload();
                }}
              >
                <Power size={12} />
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                aria-label={t('integrations.list.disconnectName', { name: i.name })}
                onClick={async () => {
                  if (
                    !(await confirmDialog({
                      title: t('integrations.list.confirmDisconnectTitle', { name: i.name }),
                      body: t('integrations.list.confirmDisconnectBody'),
                      confirmLabel: t('integrations.list.disconnect'),
                      danger: true,
                    }))
                  )
                    return;
                  await api.del(wsPath(ws.slug, `/integrations/${i.id}`));
                  reload();
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {i.lastError && <p className="mt-2 text-[12px] text-error">{i.lastError}</p>}
          </div>
        ))}
        {data.integrations.length === 0 && (
          <p className="font-mono text-[12px] text-index">{t('integrations.list.empty')}</p>
        )}
      </SettingsCard>

      <SettingsCard title={t('integrations.list.addTitle')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {data.providers.map((p) => (
            <div key={p.key} className="flex flex-col border border-border-soft bg-bg p-4">
              <div className="mb-1 font-semibold">
                {providerText('providerNames', p.key, p.name)}
              </div>
              <p className="mb-4 flex-1 text-[12.5px] text-muted">
                {providerText('providers', p.key, p.description)}
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-sm self-start"
                onClick={() => setConnecting(p)}
              >
                <Plug size={12} /> {t('integrations.list.connect')}
              </button>
            </div>
          ))}
        </div>
      </SettingsCard>

      <ConnectModal
        provider={connecting}
        onClose={() => setConnecting(null)}
        onDone={() => {
          setConnecting(null);
          reload();
        }}
      />
      <EditModal
        integration={editing}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}

/** How a chat integration receives events, as named in its summary line. */
function chatDelivery(delivery: string | undefined) {
  switch (delivery) {
    case 'events':
      return t('integrations.summary.delivery.events');
    case 'socket':
      return t('integrations.summary.delivery.socket');
    case 'interactions':
      return t('integrations.summary.delivery.interactions');
    case 'gateway':
      return t('integrations.summary.delivery.gateway');
    case 'webhook':
      return t('integrations.summary.delivery.webhook');
    case 'longpoll':
      return t('integrations.summary.delivery.longpoll');
    default:
      return '';
  }
}

function describe(i: Integration) {
  const c = i.config as {
    mode?: string;
    repos?: string[];
    projects?: string[];
    delivery?: string;
    baseUrl?: string;
    channels?: unknown[];
  };
  if (c.mode === 'app') return t('integrations.summary.githubApp');
  if (i.provider === 'email') {
    const e = i.config as { address?: string; host?: string };
    return `${e.address ?? t('integrations.summary.email')} · ${c.delivery === 'imap' ? `IMAP ${e.host}` : t('integrations.summary.webhook')}`;
  }
  if (i.provider === 'jira') {
    const j = i.config as { mode?: 'links' | 'mirror' | 'sync'; projects?: { key: string }[] };
    const keys = (j.projects ?? []).map((p) => p.key).join(', ');
    return [
      t(`integrations.summary.jiraModes.${j.mode ?? 'links'}`),
      keys,
      c.delivery === 'poll'
        ? t('integrations.summary.polling')
        : t('integrations.summary.webhooks'),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (chatForms()[i.provider]) {
    const channels = t('integrations.summary.channels', { count: c.channels?.length ?? 0 });
    return i.provider === 'matrix'
      ? `${channels} · ${t('integrations.summary.sync')}`
      : `${channels} · ${chatDelivery(c.delivery)}`;
  }
  const list = c.repos ?? c.projects ?? [];
  const where =
    list.length > 2 ? `${list.slice(0, 2).join(', ')} +${list.length - 2}` : list.join(', ');
  return `${where} · ${c.delivery === 'poll' ? t('integrations.summary.polling') : t('integrations.summary.webhooks')}`;
}

function StatusChip({ status }: { status: Integration['status'] }) {
  if (status === 'active')
    return (
      <span className="chip [--chip:var(--color-success)]">{t('integrations.status.active')}</span>
    );
  if (status === 'error')
    return (
      <span className="chip [--chip:var(--color-error)]">{t('integrations.status.error')}</span>
    );
  return <span className="tag font-mono">{t('integrations.status.off')}</span>;
}
