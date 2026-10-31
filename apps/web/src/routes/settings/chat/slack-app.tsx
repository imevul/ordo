import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { t, tx } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import { chatForms, errMsg } from './shared.ts';

// ─── Add to Slack ─────────────────────────────────────────────────────────

interface SlackAppInfo {
  app: { delivery: 'events' | 'socket'; clientId: string } | null;
  canCreate: boolean;
  https: boolean;
  publicUrl: string;
  manifests: { events: string; socket: string } | null;
}

/** The instance's Slack app: set up once by an instance admin (manifest, then credentials). */
function SlackAppForm({ info, onSaved }: { info: SlackAppInfo; onSaved: () => void }) {
  const ws = useWorkspace();
  const form = chatForms().slack!;
  const [delivery, setDelivery] = useState<'events' | 'socket'>(info.app?.delivery ?? 'events');
  const [values, setValues] = useState({
    clientId: info.app?.clientId ?? '',
    clientSecret: '',
    signingSecret: '',
    appToken: '',
  });
  const [busy, setBusy] = useState(false);
  const existing = !!info.app;
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues({ ...values, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(wsPath(ws.slug, '/integrations/slack/app'), {
        delivery,
        clientId: values.clientId.trim(),
        clientSecret: values.clientSecret.trim() || undefined,
        signingSecret: values.signingSecret.trim() || undefined,
        appToken: delivery === 'socket' ? values.appToken.trim() || undefined : undefined,
      });
      toast.success(t('integrations.slackApp.saved'));
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const secret = (
    key: 'clientSecret' | 'signingSecret' | 'appToken',
    label: string,
    placeholder?: string,
  ) => (
    <FormRow label={label} hint={existing ? t('integrations.form.keepSecret') : undefined}>
      <input
        className="input font-mono"
        type="password"
        autoComplete="off"
        required={!existing}
        placeholder={placeholder}
        value={values[key]}
        onChange={set(key)}
      />
    </FormRow>
  );

  return (
    <form onSubmit={submit}>
      <div className="mb-1 text-[12px] text-muted">{t('integrations.slackApp.step1')}</div>
      {form.deliveries.map((d) => (
        <label key={d.key} className="mb-2 flex items-start gap-2 text-[13px]">
          <input
            type="radio"
            className="mt-1 accent-primary"
            checked={delivery === d.key}
            onChange={() => setDelivery(d.key as 'events' | 'socket')}
          />
          <span>
            {d.label}
            <span className="block text-[11.5px] text-index">{d.hint}</span>
          </span>
        </label>
      ))}
      {info.manifests && (
        <>
          <div className="mt-4 mb-1 text-[12px] text-muted">{t('integrations.slackApp.step2')}</div>
          <p className="mb-2 text-[12.5px] text-muted">{t('integrations.slackApp.step2Body')}</p>
          <a
            className="btn btn-ghost btn-sm"
            href={info.manifests[delivery]}
            target="_blank"
            rel="noreferrer"
          >
            {t('integrations.slackApp.createApp')} <span className="arrow">↗</span>
          </a>
        </>
      )}
      <div className="mt-4 mb-1 text-[12px] text-muted">{t('integrations.slackApp.step3')}</div>
      <p className="mb-3 text-[12.5px] text-muted">
        {delivery === 'socket'
          ? t('integrations.slackApp.step3Socket')
          : t('integrations.slackApp.step3Body')}
      </p>
      <FormRow label={t('integrations.slackApp.clientId')}>
        <input
          className="input font-mono"
          required
          placeholder="1234567890.1234567890"
          value={values.clientId}
          onChange={set('clientId')}
        />
      </FormRow>
      {secret('clientSecret', t('integrations.slackApp.clientSecret'))}
      {secret('signingSecret', t('integrations.chat.slack.signingSecret'))}
      {delivery === 'socket' && secret('appToken', t('integrations.chat.slack.appToken'), 'xapp-…')}
      <button className="btn btn-primary" disabled={busy}>
        {t('integrations.slackApp.save')}
      </button>
    </form>
  );
}

export function SlackAppPanel({ onCancel }: { onCancel: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'slack-app'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<SlackAppInfo>(wsPath(ws.slug, '/integrations/slack/app')),
  });
  const [changing, setChanging] = useState(false);
  if (!data) return null;

  const install = async () => {
    try {
      const { url } = await api.post<{ url: string }>(
        wsPath(ws.slug, '/integrations/slack/install'),
      );
      window.location.assign(url);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const saved = () => {
    setChanging(false);
    qc.invalidateQueries({ queryKey: key });
  };

  return (
    <div>
      {!data.https && (
        <p className="mb-4 border border-warning/40 bg-warning/5 p-3 text-[12.5px] text-muted">
          {tx('integrations.slackApp.needsHttps', {
            url: <span className="font-mono">{data.publicUrl}</span>,
          })}
        </p>
      )}
      {data.app ? (
        <>
          <p className="mb-4 text-[12.5px] text-muted">{t('integrations.slackApp.intro')}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={install}
            disabled={!data.https}
          >
            {t('integrations.slackApp.add')} <span className="arrow">→</span>
          </button>
          {data.canCreate && (
            <div className="mt-6 border-t border-border-soft pt-4">
              {changing ? (
                <>
                  <p className="mb-4 text-[12.5px] text-muted">
                    {t('integrations.slackApp.changeHint')}
                  </p>
                  <SlackAppForm info={data} onSaved={saved} />
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setChanging(true)}
                >
                  {t('integrations.slackApp.change')}
                </button>
              )}
            </div>
          )}
        </>
      ) : data.canCreate ? (
        <>
          <p className="mb-4 text-[12.5px] text-muted">{t('integrations.slackApp.setupIntro')}</p>
          <SlackAppForm info={data} onSaved={saved} />
        </>
      ) : (
        <p className="text-[13px] text-muted">{t('integrations.slackApp.needsInstanceAdmin')}</p>
      )}
      <div className="mt-6 flex justify-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
