import type { ChatChannel, Integration, IntegrationProviderInfo } from '@ordo/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import { ChannelsEditor } from './channels.tsx';
import { chatForms, errMsg } from './shared.ts';

/** Connecting or editing a chat integration. */
export function ChatForm({
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
  const form = chatForms()[provider.key]!;
  const config = (existing?.config ?? {}) as Record<string, unknown>;
  const [delivery, setDelivery] = useState(
    String(config.delivery ?? form.deliveries[0]?.key ?? ''),
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      form.fields.map((f) => [
        f.key,
        f.checkbox
          ? String(existing ? config[f.key] === true : true)
          : f.secret
            ? ''
            : String(config[f.key] ?? ''),
      ]),
    ),
  );
  const [channels, setChannels] = useState<ChatChannel[]>(
    (config.channels as ChatChannel[] | undefined) ?? [],
  );
  const [busy, setBusy] = useState(false);
  // Added with "Add to Slack": Slack manages the token and the app decides the delivery.
  const appMode = config.mode === 'app';
  const fields = appMode ? [] : form.fields.filter((f) => !f.for || f.for.includes(delivery));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const cfg: Record<string, unknown> = {
      channels: channels.map((c) => ({ ...c, name: c.name || undefined })),
      ...(delivery && !appMode && { delivery }),
    };
    const secrets: Record<string, string> = {};
    for (const f of fields) {
      if (f.checkbox) cfg[f.key] = values[f.key] === 'true';
      else (f.secret ? secrets : cfg)[f.key] = values[f.key]!.trim();
    }
    try {
      const res = existing
        ? await api.patch<Integration>(wsPath(ws.slug, `/integrations/${existing.id}`), {
            config: cfg,
            secrets,
          })
        : await api.post<Integration>(wsPath(ws.slug, '/integrations'), {
            provider: provider.key,
            config: cfg,
            secrets,
          });
      if (res.status === 'error')
        toast.error(t('integrations.form.savedButError', { error: res.lastError ?? '' }));
      else
        toast.success(
          existing
            ? t('common.saved')
            : t('integrations.form.connected', { provider: provider.name }),
        );
      onDone();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-[12.5px] text-muted">
        {appMode
          ? t('integrations.slackApp.connectedWith', {
              team: String(config.team ?? existing?.name ?? ''),
            })
          : form.docs}
      </p>
      {form.deliveries.length > 0 && !appMode && (
        <>
          <div className="mb-1 text-[12px] text-muted">
            {t('integrations.chat.deliveryHeading', { provider: provider.name })}
          </div>
          {form.deliveries.map((d) => (
            <label key={d.key} className="mb-2 flex items-start gap-2 text-[13px]">
              <input
                type="radio"
                className="mt-1 accent-primary"
                checked={delivery === d.key}
                onChange={() => setDelivery(d.key)}
              />
              <span>
                {d.label}
                <span className="block text-[11.5px] text-index">{d.hint}</span>
              </span>
            </label>
          ))}
          <div className="mb-4" />
        </>
      )}
      {fields.map((f) =>
        f.checkbox ? (
          <label key={f.key} className="mb-4 flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={values[f.key] === 'true'}
              onChange={(e) => setValues({ ...values, [f.key]: String(e.target.checked) })}
            />
            <span>
              {f.label}
              {f.hint && <span className="block text-[11.5px] text-index">{f.hint}</span>}
            </span>
          </label>
        ) : (
          <FormRow
            key={f.key}
            label={f.label}
            hint={f.secret && existing ? t('integrations.form.keepSecret') : f.hint}
          >
            <input
              className="input font-mono"
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              required={!(f.secret && existing)}
              placeholder={f.placeholder}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </FormRow>
        ),
      )}
      <ChannelsEditor value={channels} onChange={setChannels} hint={form.channelHint} />
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {existing ? t('common.save') : t('integrations.form.connect')}
        </button>
      </div>
    </form>
  );
}
