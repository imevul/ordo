import type { Integration, IntegrationProviderInfo } from '@ordo/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
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
      if (res.status === 'error') toast.error(`Saved, but: ${res.lastError}`);
      else toast.success(existing ? 'Saved' : 'Email intake connected');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-[12.5px] text-muted">
        Mail to this address becomes an issue in the team below — in triage, if the team has it —
        filed under the sender’s customer. Replies in the same thread become comments. Auto-replies
        and bounces are ignored.
      </p>
      <FormRow label="Team">
        <select
          className="input"
          value={v.teamId}
          onChange={(e) => set({ teamId: e.target.value })}
        >
          {ws.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.triageEnabled ? '' : ' (no triage: new issues land in its default status)'}
            </option>
          ))}
        </select>
      </FormRow>
      <FormRow label="Address" hint="The address people write to; shown in Ordo only.">
        <input
          className="input font-mono"
          placeholder="support@example.com"
          value={v.address}
          onChange={(e) => set({ address: e.target.value })}
        />
      </FormRow>
      <div className="mt-4 mb-2 flex flex-col gap-2 text-[13px]">
        {[
          [
            'imap',
            'Check a mailbox (IMAP)',
            'Ordo reads new mail every minute and marks it read. Works behind NAT and firewalls.',
          ],
          [
            'webhook',
            'Receive by webhook',
            'Something that gets your mail (an email worker, a mail server pipe) POSTs each raw message to Ordo.',
          ],
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
            <FormRow label="IMAP server">
              <input
                className="input font-mono"
                required
                placeholder="imap.example.com"
                value={v.host}
                onChange={(e) => set({ host: e.target.value })}
              />
            </FormRow>
            <FormRow label="Port">
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
            TLS (port 993); untick for STARTTLS on 143
          </label>
          <FormRow label="User name">
            <input
              className="input font-mono"
              required
              autoComplete="off"
              value={v.username}
              onChange={(e) => set({ username: e.target.value })}
            />
          </FormRow>
          <FormRow
            label="Password"
            hint={
              existing
                ? 'Leave empty to keep the current one.'
                : 'An app password, where the provider has them.'
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
          <FormRow label="Folder">
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
          POST each message, raw (<code className="font-mono">message/rfc822</code>), to the webhook
          URL above.
        </p>
      )}
      {!imap && !existing && (
        <p className="mt-3 text-[12.5px] text-muted">
          The webhook URL appears once connected. {team ? `Issues go to ${team.name}.` : ''}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !v.teamId}>
          {existing ? 'Save' : 'Connect'}
        </button>
      </div>
    </form>
  );
}
