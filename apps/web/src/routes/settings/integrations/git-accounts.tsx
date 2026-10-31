import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { errMsg } from './shared.ts';

// ─── Account → Git usernames ─────────────────────────────────────────────

interface Claims {
  services: { provider: string; name: string; host: string }[];
  accounts: { id: string; provider: string; host: string; username: string }[];
}

/** People claim their forge usernames so pull requests they open are credited to them. */
export function GitAccountsCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'external-accounts'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Claims>(wsPath(ws.slug, '/me/external-accounts')),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!data?.services.length) return null;
  const reload = () => qc.invalidateQueries({ queryKey: key });
  return (
    <SettingsCard
      title={t('integrations.gitAccounts.title')}
      description={t('integrations.gitAccounts.description', { workspace: ws.workspace.name })}
    >
      {data.services.map((s) => {
        const id = `${s.provider}:${s.host}`;
        const mine = data.accounts.filter((a) => a.provider === s.provider && a.host === s.host);
        return (
          <div key={id} className="border-b border-border-soft py-3">
            <div className="mb-2 text-[13px]">
              {s.name} <span className="font-mono text-[11.5px] text-index">{s.host}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {mine.map((a) => (
                <span key={a.id} className="tag inline-flex items-center gap-1 font-mono">
                  <AtSign size={11} />
                  {a.username}
                  <button
                    type="button"
                    aria-label={t('integrations.gitAccounts.remove', { username: a.username })}
                    className="text-index hover:text-text"
                    onClick={async () => {
                      await api.del(wsPath(ws.slug, `/me/external-accounts/${a.id}`));
                      reload();
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api.post(wsPath(ws.slug, '/me/external-accounts'), {
                      provider: s.provider,
                      host: s.host,
                      username: drafts[id] ?? '',
                    });
                    setDrafts({ ...drafts, [id]: '' });
                    reload();
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <input
                  className="input h-7 w-44 font-mono text-[12px]"
                  placeholder={t('integrations.gitAccounts.placeholder')}
                  value={drafts[id] ?? ''}
                  onChange={(e) => setDrafts({ ...drafts, [id]: e.target.value })}
                  aria-label={t('integrations.gitAccounts.usernameLabel', { service: s.name })}
                />
                <button className="btn btn-ghost btn-sm">{t('common.add')}</button>
              </form>
            </div>
          </div>
        );
      })}
    </SettingsCard>
  );
}
