import type { Account, Passkey } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../api/client.ts';
import { useConfig } from '../../../api/queries.ts';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { relativeTime } from '../../../lib/format.ts';
import { addPasskey, deviceName, passkeyCancelled, passkeysHere } from '../../../lib/passkeys.ts';
import { FormRow, SettingsCard } from '../ui.tsx';

import { errMsg, useRefreshAccount } from './shared.ts';
import { RecoveryCodes } from './two-factor.tsx';

/**
 * Adding or removing a passkey, or new recovery codes for an account whose only second factor is
 * passkeys: the password (when the account has one), and a name for new passkeys.
 */
type PasskeyStep =
  | { kind: 'add' }
  | { kind: 'remove'; id: string; name: string }
  | { kind: 'codes' }
  | null;

export function PasskeysCard({ account }: { account: Account }) {
  const config = useConfig();
  const qc = useQueryClient();
  const queryKey = ['me', 'passkeys'];
  const { data: list = [] } = useQuery({
    queryKey,
    queryFn: () => api.get<Passkey[]>('/me/passkeys'),
  });
  const [step, setStep] = useState<PasskeyStep>(null);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refreshAccount = useRefreshAccount();
  const refresh = () => {
    qc.invalidateQueries({ queryKey });
    refreshAccount();
  };

  const origin = config.data?.passkeyOrigin;
  if (!passkeysHere(origin)) {
    return (
      <SettingsCard title={t('settings.passkeys.title')}>
        <p className="text-[13px] text-muted">
          {!origin
            ? t('settings.passkeys.needsHttps')
            : origin !== window.location.origin
              ? t('settings.passkeys.otherOrigin', { origin })
              : t('settings.passkeys.unsupported')}
        </p>
      </SettingsCard>
    );
  }

  const start = (next: PasskeyStep) => {
    setPassword('');
    setName(deviceName());
    setStep(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!step) return;
    setBusy(true);
    try {
      const pw = account.hasPassword ? password : undefined;
      if (step.kind === 'add') {
        const added = await addPasskey(pw, name.trim() || deviceName());
        if (added.recoveryCodes) setCodes(added.recoveryCodes);
        toast.success(t('settings.passkeys.added'));
      } else if (step.kind === 'codes') {
        const res = await api.post<{ recoveryCodes: string[] }>('/me/2fa/recovery-codes', {
          password: pw,
        });
        setCodes(res.recoveryCodes);
      } else {
        await api.del(`/me/passkeys/${step.id}`, account.hasPassword ? { password } : {});
        toast.success(t('settings.passkeys.removed'));
        // The last second factor took its recovery codes with it.
        if (list.length === 1 && !account.totpEnabled) setCodes(null);
      }
      setStep(null);
      refresh();
    } catch (err) {
      if (!passkeyCancelled(err)) toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Passkey) => {
    if (account.hasPassword) return start({ kind: 'remove', id: p.id, name: p.name });
    const ok = await confirmDialog({
      title: t('settings.passkeys.removeTitle', { name: p.name }),
      body: t('settings.passkeys.removeBody'),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/me/passkeys/${p.id}`, {});
      if (list.length === 1 && !account.totpEnabled) setCodes(null);
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const rename = async (p: Passkey, next: string) => {
    setRenaming(null);
    if (!next.trim() || next.trim() === p.name) return;
    try {
      await api.patch(`/me/passkeys/${p.id}`, { name: next.trim() });
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard
      title={t('settings.passkeys.title')}
      description={t('settings.passkeys.description')}
    >
      {codes && (
        <div className="mb-4">
          <RecoveryCodes codes={codes} />
        </div>
      )}
      {list.map((p) => (
        <div
          key={p.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft py-2.5 text-[13px]"
        >
          <Fingerprint size={14} className="flex-none text-index" />
          {renaming === p.id ? (
            <input
              className="input h-7 min-w-0 flex-1 py-0 text-[13px]"
              defaultValue={p.name}
              aria-label={t('settings.passkeys.name')}
              autoFocus
              onBlur={(e) => rename(p, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename(p, e.currentTarget.value);
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left hover:text-highlight"
              title={t('settings.passkeys.rename')}
              onClick={() => setRenaming(p.id)}
            >
              {p.name}
            </button>
          )}
          {p.backedUp && <span className="tag">{t('settings.passkeys.synced')}</span>}
          <span className="font-mono text-[11px] text-index">
            {p.lastUsedAt
              ? t('settings.passkeys.used', { time: relativeTime(p.lastUsedAt) })
              : t('settings.passkeys.addedAgo', { time: relativeTime(p.createdAt) })}
          </span>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center text-index hover:text-error"
            aria-label={t('settings.passkeys.removeNamed', { name: p.name })}
            onClick={() => remove(p)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {list.length === 0 && (
        <p className="mb-3 font-mono text-[12px] text-index">{t('settings.passkeys.empty')}</p>
      )}
      {step ? (
        <form onSubmit={submit} className="mt-4">
          {step.kind === 'add' && (
            <FormRow label={t('settings.passkeys.name')}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </FormRow>
          )}
          {step.kind === 'remove' && (
            <p className="mb-3 text-[13px] text-muted">
              {t('settings.passkeys.removeTitle', { name: step.name })}{' '}
              {t('settings.passkeys.removeBody')}
            </p>
          )}
          {step.kind === 'codes' && (
            <p className="mb-3 text-[13px] text-muted">{t('settings.passkeys.newCodesBody')}</p>
          )}
          {account.hasPassword && (
            <FormRow label={t('settings.passkeys.confirmPassword')}>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormRow>
          )}
          <div className="flex gap-2">
            <button
              className={`btn ${step.kind === 'remove' ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy}
            >
              {step.kind === 'remove'
                ? t('common.remove')
                : step.kind === 'codes'
                  ? t('settings.passkeys.newCodes')
                  : t('common.continue')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost" onClick={() => start({ kind: 'add' })}>
            <Fingerprint size={12} /> {t('settings.passkeys.add')}
          </button>
          {/* With an authenticator app, its card hands out recovery codes instead. */}
          {list.length > 0 && !account.totpEnabled && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => start({ kind: 'codes' })}
            >
              {t('settings.twoFactor.newRecoveryCodes')}
            </button>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
