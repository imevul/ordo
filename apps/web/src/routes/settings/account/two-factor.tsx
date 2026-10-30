import type { Account } from '@ordo/shared';
import { Copy, Download, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../api/client.ts';
import { Modal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { FormRow, SettingsCard } from '../ui.tsx';

import { errMsg, useRefreshAccount, useRefreshCredentials } from './shared.ts';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  return (
    <div className="panel panel-sm p-4 [--panel-border:var(--color-primary)]">
      <div className="kicker mb-3">{t('settings.twoFactor.recoveryKicker')}</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[13px]">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            navigator.clipboard?.writeText(text);
            toast.success(t('common.copied'));
          }}
        >
          <Copy size={12} /> {t('common.copy')}
        </button>
        <a
          className="btn btn-ghost btn-sm"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${t('settings.twoFactor.recoveryFileTitle')}\n\n${text}\n`)}`}
          download="ordo-recovery-codes.txt"
        >
          <Download size={12} /> {t('settings.download')}
        </a>
      </div>
    </div>
  );
}

export function TwoFactorCard({ account }: { account: Account }) {
  const refresh = useRefreshAccount();
  const refreshCredentials = useRefreshCredentials();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [revoke, setRevoke] = useState(true);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ secret: string; uri: string }>('/me/2fa/setup', {
        password: password || undefined,
      });
      const qr = await QRCode.toDataURL(res.uri, {
        margin: 1,
        width: 200,
        color: { dark: '#09090b', light: '#fff4fa' },
      });
      setSetup({ ...res, qr });
      setPassword('');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/me/2fa/enable', {
        code,
        revokeCredentials: revoke,
      });
      setCodes(res.recoveryCodes);
      setSetup(null);
      setCode('');
      refresh();
      if (revoke) refreshCredentials();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/me/2fa/disable', { password: password || undefined, code });
      setDisabling(false);
      setPassword('');
      setCode('');
      setCodes(null);
      refresh();
      toast.success(t('settings.twoFactor.turnedOff'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const regenerate = async () => {
    const c = prompt(t('settings.twoFactor.regeneratePrompt'));
    if (!c) return;
    try {
      setCodes(
        (await api.post<{ recoveryCodes: string[] }>('/me/2fa/recovery-codes', { code: c }))
          .recoveryCodes,
      );
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard
      title={t('settings.twoFactor.title')}
      description={t('settings.twoFactor.description')}
    >
      {codes && (
        <div className="mb-4">
          <RecoveryCodes codes={codes} />
        </div>
      )}
      {account.totpEnabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip mr-2 [--chip:var(--color-success)]">
            {t('settings.twoFactor.on')}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={regenerate}>
            {t('settings.twoFactor.newRecoveryCodes')}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => setDisabling(true)}
          >
            {t('settings.turnOff')}
          </button>
        </div>
      ) : (
        <form onSubmit={start} className="flex flex-wrap gap-2">
          {account.hasPassword && (
            <input
              className="input w-64"
              type="password"
              placeholder={t('settings.currentPassword')}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
          <button className="btn btn-primary">
            <ShieldCheck size={13} /> {t('settings.twoFactor.setUp')}
          </button>
        </form>
      )}

      <Modal
        open={!!setup}
        onClose={() => setSetup(null)}
        width={460}
        label={t('settings.twoFactor.setupLabel')}
        align="center"
      >
        {setup && (
          <form onSubmit={enable} className="p-6">
            <div className="section-label mb-4">{t('settings.twoFactor.scanTitle')}</div>
            <div className="flex gap-5">
              <img
                src={setup.qr}
                alt={t('settings.twoFactor.qrAlt')}
                width={160}
                height={160}
                className="flex-none"
              />
              <div className="min-w-0 text-[13px] text-muted">
                {t('settings.twoFactor.scanHelp')}
                <code className="mt-2 block break-all font-mono text-[12px] text-text">
                  {setup.secret}
                </code>
              </div>
            </div>
            <div className="mt-6" />
            <FormRow label={t('settings.twoFactor.codeFromApp')}>
              <input
                className="input font-mono tracking-[0.3em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                required
              />
            </FormRow>
            <label className="mb-4 flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="accent-primary"
                checked={revoke}
                onChange={(e) => setRevoke(e.target.checked)}
              />
              {t('settings.revokeCredentials')}
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setSetup(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" disabled={code.length !== 6}>
                {t('settings.turnOn')} <span className="arrow">→</span>
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={disabling}
        onClose={() => setDisabling(false)}
        width={420}
        label={t('settings.twoFactor.disableLabel')}
        align="center"
      >
        <form onSubmit={disable} className="p-6">
          <div className="section-label mb-4">{t('settings.twoFactor.disableTitle')}</div>
          {account.hasPassword && (
            <FormRow label={t('settings.currentPassword')}>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </FormRow>
          )}
          <FormRow label={t('settings.twoFactor.disableCode')}>
            <input
              className="input font-mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </FormRow>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setDisabling(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger">{t('settings.turnOff')}</button>
          </div>
        </form>
      </Modal>
    </SettingsCard>
  );
}
