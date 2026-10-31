import type { Integration, IntegrationProviderInfo } from '@ordo/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import { errMsg, providerText } from './shared.ts';

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
  initial?: string;
}

/** What each forge needs when connecting with a token. A function: labels follow the language. */
export const tokenForms = (): Record<string, { fields: Field[]; docs: string }> => ({
  github: {
    docs: t('integrations.forge.github.docs'),
    fields: [
      {
        key: 'token',
        label: t('integrations.forge.github.token'),
        secret: true,
        placeholder: 'github_pat_…',
      },
      {
        key: 'repos',
        label: t('integrations.forge.repositories'),
        multiline: true,
        placeholder: 'acme/app\nacme/api',
        hint: t('integrations.forge.ownerNamePerLine'),
      },
      {
        key: 'apiUrl',
        label: t('integrations.forge.github.apiUrl'),
        initial: 'https://api.github.com',
        hint: t('integrations.forge.github.apiUrlHint'),
      },
      {
        key: 'webUrl',
        label: t('integrations.forge.github.webUrl'),
        initial: 'https://github.com',
      },
    ],
  },
  gitlab: {
    docs: t('integrations.forge.gitlab.docs'),
    fields: [
      {
        key: 'baseUrl',
        label: t('integrations.forge.gitlab.baseUrl'),
        initial: 'https://gitlab.com',
      },
      {
        key: 'token',
        label: t('integrations.forge.accessToken'),
        secret: true,
        placeholder: 'glpat-…',
      },
      {
        key: 'projects',
        label: t('integrations.forge.gitlab.projects'),
        multiline: true,
        placeholder: 'acme/app\nacme/platform/api',
        hint: t('integrations.forge.gitlab.projectsHint'),
      },
    ],
  },
  forgejo: {
    docs: t('integrations.forge.forgejo.docs'),
    fields: [
      {
        key: 'baseUrl',
        label: t('integrations.forge.forgejo.baseUrl'),
        placeholder: 'https://codeberg.org',
      },
      { key: 'token', label: t('integrations.forge.accessToken'), secret: true },
      {
        key: 'repos',
        label: t('integrations.forge.repositories'),
        multiline: true,
        placeholder: 'acme/app',
        hint: t('integrations.forge.ownerNamePerLine'),
      },
    ],
  },
});

/** Webhooks or polling, and whether to comment on pull requests. Shared by connect and edit. */
function DeliveryFields({
  delivery,
  setDelivery,
  comment,
  setComment,
  providerName,
}: {
  delivery: string;
  setDelivery: (v: string) => void;
  comment: boolean;
  setComment: (v: boolean) => void;
  providerName: string;
}) {
  const local = /localhost|127\.0\.0\.1|\.local\b|\.lan\b/.test(location.host);
  return (
    <>
      <div className="mb-1 text-[12px] text-muted">{t('integrations.forge.deliveryHeading')}</div>
      <label className="mb-1 flex items-start gap-2 text-[13px]">
        <input
          type="radio"
          className="mt-1 accent-primary"
          checked={delivery === 'webhook'}
          onChange={() => setDelivery('webhook')}
        />
        <span>
          {t('integrations.forge.webhooks')}
          <span className="block text-[11.5px] text-index">
            {t('integrations.forge.webhooksHint', {
              provider: providerName,
              origin: location.origin,
            })}
          </span>
        </span>
      </label>
      <label className="mb-4 flex items-start gap-2 text-[13px]">
        <input
          type="radio"
          className="mt-1 accent-primary"
          checked={delivery === 'poll'}
          onChange={() => setDelivery('poll')}
        />
        <span>
          {t('integrations.forge.polling')}
          <span className="block text-[11.5px] text-index">
            {local
              ? t('integrations.forge.pollingHintLocal', { provider: providerName })
              : t('integrations.forge.pollingHint', { provider: providerName })}
          </span>
        </span>
      </label>
      <label className="mb-2 flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          className="accent-primary"
          checked={comment}
          onChange={(e) => setComment(e.target.checked)}
        />
        {t('integrations.forge.commentOnPullRequests')}
      </label>
    </>
  );
}

export function TokenForm({
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
  const form = tokenForms()[provider.key]!;
  const config = (existing?.config ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      form.fields.map((f) => {
        const current = config[f.key];
        return [
          f.key,
          f.secret
            ? ''
            : Array.isArray(current)
              ? current.join('\n')
              : String(current ?? f.initial ?? ''),
        ];
      }),
    ),
  );
  const [delivery, setDelivery] = useState(String(config.delivery ?? 'webhook'));
  const [comment, setComment] = useState(config.commentOnPullRequests === true);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const cfg: Record<string, unknown> = { delivery, commentOnPullRequests: comment };
    const secrets: Record<string, string> = {};
    for (const f of form.fields) (f.secret ? secrets : cfg)[f.key] = values[f.key]!;
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
      <p className="mb-4 text-[12.5px] text-muted">{form.docs}</p>
      {form.fields.map((f) => (
        <FormRow
          key={f.key}
          label={f.label}
          hint={f.secret && existing ? t('integrations.form.keepSecret') : f.hint}
        >
          {f.multiline ? (
            <textarea
              className="input min-h-20 font-mono"
              required
              placeholder={f.placeholder}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          ) : (
            <input
              className="input font-mono"
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              required={!(f.secret && existing) && !f.initial}
              placeholder={f.placeholder}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          )}
        </FormRow>
      ))}
      <DeliveryFields
        delivery={delivery}
        setDelivery={setDelivery}
        comment={comment}
        setComment={setComment}
        providerName={providerText('providerNames', provider.key, provider.name)}
      />
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
