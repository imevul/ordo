import type { Integration, IntegrationProviderInfo } from '@ordo/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { t, tx } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow } from './ui.tsx';

/** Connects (or edits) email intake: which team gets the issues, and how mail reaches Ordo. */
export function EmailForm({
  provider,
  existing,
  onDone,
  onCancel,
}: {
  provider: IntegrationProviderInfo;
  existing?: Integration;
  onDone: () => void;
  onCancel: () => void;
}) {
  const ws = useWorkspace();
  const c = (existing?.config ?? {}) as Record<string, unknown>;
  const [v, setV] = useState({
    delivery: String(c.delivery ?? 'imap'),
    teamId: String(c.teamId ?? ws.teams.find((t) => t.triageEnabled)?.id ?? ws.teams[0]?.id ?? ''),
    address: String(c.address ?? ''),
    host: String(c.host ?? ''),
    port: String(c.port ?? '993'),
    secure: c.secure !== false,
    username: String(c.username ?? ''),
    password: '',
    mailbox: String(c.mailbox ?? 'INBOX'),
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const imap = v.delivery === 'imap';
  const team = ws.teamById.get(v.teamId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const config = {
      delivery: v.delivery,
      teamId: v.teamId,
      address: v.address,
      ...(imap && {
        host: v.host,
        port: Number(v.port) || 993,
        secure: v.secure,
        username: v.username,
        mailbox: v.mailbox,
      }),
    };
    const secrets = imap ? { password: v.password } : {};
    try {
      const res = existing
        ? await api.patch<Integration>(wsPath(ws.slug, `/integrations/${existing.id}`), {
            config,
            secrets,
          })
        : await api.post<Integration>(wsPath(ws.slug, '/integrations'), {
            provider: provider.key,
            name: v.address || undefined,
            config,
            secrets,
          });
      if (res.status === 'error')
        toast.error(t('integrations.form.savedButError', { error: res.lastError ?? '' }));
      else toast.success(existing ? t('common.saved') : t('integrations.email.connected'));
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-[12.5px] text-muted">{t('integrations.email.intro')}</p>
      <FormRow label={t('common.team')}>
        <select
          className="input"
          value={v.teamId}
          onChange={(e) => set({ teamId: e.target.value })}
        >
          {ws.teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.triageEnabled
                ? team.name
                : t('integrations.email.teamNoTriage', { team: team.name })}
            </option>
          ))}
        </select>
      </FormRow>
      <FormRow label={t('integrations.email.address')} hint={t('integrations.email.addressHint')}>
        <input
          className="input font-mono"
          placeholder="support@example.com"
          value={v.address}
          onChange={(e) => set({ address: e.target.value })}
        />
      </FormRow>
      <div className="mt-4 mb-2 flex flex-col gap-2 text-[13px]">
        {[
          ['imap', t('integrations.email.imap'), t('integrations.email.imapHint')],
          ['webhook', t('integrations.email.webhook'), t('integrations.email.webhookHint')],
        ].map(([key, label, hint]) => (
          <label key={key} className="flex items-start gap-2">
            <input
              type="radio"
              className="mt-1 accent-primary"
              checked={v.delivery === key}
              onChange={() => set({ delivery: key! })}
            />
            <span>
              {label}
              <span className="block text-[12px] text-index">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      {imap && (
        <>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <FormRow label={t('integrations.email.imapServer')}>
              <input
                className="input font-mono"
                required
                placeholder="imap.example.com"
                value={v.host}
                onChange={(e) => set({ host: e.target.value })}
              />
            </FormRow>
            <FormRow label={t('integrations.email.port')}>
              <input
                className="input font-mono"
                value={v.port}
                onChange={(e) => set({ port: e.target.value })}
              />
            </FormRow>
          </div>
          <label className="mb-3 flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              className="accent-primary"
              checked={v.secure}
              onChange={(e) => set({ secure: e.target.checked })}
            />
            {t('integrations.email.tls')}
          </label>
          <FormRow label={t('integrations.email.username')}>
            <input
              className="input font-mono"
              required
              autoComplete="off"
              value={v.username}
              onChange={(e) => set({ username: e.target.value })}
            />
          </FormRow>
          <FormRow
            label={t('integrations.email.password')}
            hint={
              existing ? t('integrations.form.keepSecret') : t('integrations.email.passwordHint')
            }
          >
            <input
              className="input font-mono"
              type="password"
              autoComplete="off"
              required={!existing}
              value={v.password}
              onChange={(e) => set({ password: e.target.value })}
            />
          </FormRow>
          <FormRow label={t('integrations.email.folder')}>
            <input
              className="input font-mono"
              value={v.mailbox}
              onChange={(e) => set({ mailbox: e.target.value })}
            />
          </FormRow>
        </>
      )}
      {!imap && existing?.inboundUrl && (
        <p className="mt-3 text-[12.5px] text-muted">
          {tx('integrations.email.postRaw', {
            type: <code className="font-mono">message/rfc822</code>,
          })}
        </p>
      )}
      {!imap && !existing && (
        <p className="mt-3 text-[12.5px] text-muted">
          {t('integrations.email.webhookAfterConnect')}
          {team && ` ${t('integrations.email.issuesGoTo', { team: team.name })}`}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !v.teamId}>
          {existing ? t('common.save') : t('integrations.form.connect')}
        </button>
      </div>
    </form>
  );
}
