import { useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../api/client.ts';
import { keys, useApiKeys } from '../../../api/queries.ts';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t, tx } from '../../../i18n/index.ts';
import { relativeTime } from '../../../lib/format.ts';
import { SettingsCard } from '../ui.tsx';

import { errMsg } from './shared.ts';

export function ApiKeysSection() {
  const qc = useQueryClient();
  const { data: list = [] } = useApiKeys();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ token: string }>('/me/api-keys', { name });
      setCreated(res.token);
      setName('');
      qc.invalidateQueries({ queryKey: keys.apiKeys });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const revoke = async (id: string) => {
    if (
      !(await confirmDialog({
        title: t('settings.apiKeys.revokeTitle'),
        body: t('settings.apiKeys.revokeBody'),
        confirmLabel: t('settings.apiKeys.revokeConfirm'),
        danger: true,
      }))
    )
      return;
    await api.del(`/me/api-keys/${id}`);
    qc.invalidateQueries({ queryKey: keys.apiKeys });
  };

  return (
    <SettingsCard
      title={t('settings.apiKeys.title')}
      description={tx('settings.apiKeys.description', {
        header: <code className="font-mono text-highlight">Authorization: Bearer ordo_…</code>,
        doc: <span className="font-mono">docs/api.md</span>,
      })}
    >
      <form onSubmit={create} className="mb-5 flex gap-2">
        <input
          className="input"
          placeholder={t('settings.apiKeys.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button className="btn btn-primary">
          <KeyRound size={13} /> {t('common.create')}
        </button>
      </form>
      {created && (
        <div className="panel panel-sm mb-5 p-4 [--panel-border:var(--color-primary)]">
          <div className="kicker mb-2">{t('settings.apiKeys.copyNow')}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{created}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(created);
                toast.success(t('common.copied'));
              }}
            >
              <Copy size={12} /> {t('common.copy')}
            </button>
          </div>
        </div>
      )}
      {list.map((k) => (
        <div key={k.id} className="flex h-11 items-center gap-3 border-b border-border-soft">
          <KeyRound size={14} className="text-muted" />
          <span className="min-w-0 flex-1 truncate">{k.name}</span>
          <span className="font-mono text-[11.5px] text-index">{k.prefix}…</span>
          <span className="hidden min-w-32 flex-none text-right font-mono text-[11px] text-index sm:block">
            {k.lastUsedAt
              ? t('settings.apiKeys.used', { time: relativeTime(k.lastUsedAt) })
              : t('settings.apiKeys.neverUsed')}
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => revoke(k.id)}
            aria-label={t('settings.apiKeys.revokeKey', { name: k.name })}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {list.length === 0 && !created && (
        <p className="font-mono text-[12px] text-index">{t('settings.apiKeys.empty')}</p>
      )}
    </SettingsCard>
  );
}

/** The ordo CLI, served by this instance; it signs in with a personal key. */
export function CliCard() {
  const origin = window.location.origin;
  const install = `curl -fsSL ${origin}/cli/ordo.mjs -o ~/.local/bin/ordo && chmod +x ~/.local/bin/ordo\nordo login ${origin}`;
  return (
    <SettingsCard
      title={t('settings.cli.title')}
      description={tx('settings.cli.description', {
        command: <span className="font-mono text-text">ordo</span>,
        doc: <span className="font-mono">docs/cli.md</span>,
      })}
    >
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto border border-border-soft bg-bg p-3 font-mono text-[11.5px] leading-relaxed">
          {install}
        </pre>
        <button
          type="button"
          className="btn btn-ghost btn-sm flex-none"
          onClick={() => {
            navigator.clipboard?.writeText(install);
            toast.success(t('common.copied'));
          }}
        >
          <Copy size={12} /> {t('common.copy')}
        </button>
      </div>
    </SettingsCard>
  );
}
