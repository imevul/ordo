import type { LinkedIdentity } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../../api/client.ts';
import { t } from '../../../i18n/index.ts';
import { relativeTime } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { errMsg, here, useRedirectError } from './shared.tsx';

// ─── Account → Connected accounts ──────────────────────────────────────

export function ConnectedAccountsCard() {
  useRedirectError();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['me', 'identities'];
  const { data: identities = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<LinkedIdentity[]>('/me/identities'),
  });
  const { data: options } = useQuery({
    queryKey: ['auth-providers', ws.slug],
    queryFn: () =>
      api.get<{ options: { providerId: string; name: string }[] }>(
        `/auth/providers?workspace=${encodeURIComponent(ws.slug)}`,
      ),
  });
  const linked = new Set(identities.map((i) => `${i.workspace}:${i.provider}`));
  const linkable = (options?.options ?? []).filter(
    (o) => !linked.has(`${ws.workspace.name}:${o.name}`),
  );
  return (
    <SettingsCard title={t('sso.connected.title')} description={t('sso.connected.description')}>
      {identities.map((i) => (
        <div key={i.id} className="flex h-12 items-center gap-3 border-b border-border-soft">
          <KeyRound size={14} className="flex-none text-highlight" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px]">
              {i.provider} <span className="text-index">· {i.workspace}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {i.email ?? t('sso.connected.noEmail')}
              {i.lastLoginAt &&
                ` · ${t('sso.connected.lastUsed', { time: relativeTime(i.lastLoginAt) })}`}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              try {
                await api.del(`/me/identities/${i.id}`);
                qc.invalidateQueries({ queryKey: key });
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <Unlink size={12} /> {t('sso.connected.unlink')}
          </button>
        </div>
      ))}
      {identities.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('sso.connected.empty')}</p>
      )}
      {linkable.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {linkable.map((o) => (
            <button
              type="button"
              key={o.providerId}
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                try {
                  const { url } = await api.post<{ url: string }>(
                    `/auth/sso/${encodeURIComponent(o.providerId)}/link`,
                    { redirect: here() },
                  );
                  window.location.assign(url);
                } catch (err) {
                  toast.error(errMsg(err));
                }
              }}
            >
              <Link2 size={12} /> {t('sso.connected.connect', { name: o.name })}
            </button>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
