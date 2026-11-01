import {
  REQUEST_FORM_CAPTCHA_PROVIDERS,
  REQUEST_FORM_FIELD_TYPES,
  type RequestForm,
  type RequestFormCaptchaProvider,
  type RequestFormField,
  type RequestFormFieldType,
  type Team,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const CAPTCHA_NAMES: Record<RequestFormCaptchaProvider, string> = {
  turnstile: 'Cloudflare Turnstile',
  hcaptcha: 'hCaptcha',
};

const copy = (text: string) => {
  navigator.clipboard.writeText(text);
  toast.success(t('common.copied'));
};

const newFieldId = () => `q${Math.random().toString(36).slice(2, 10)}`;

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="mb-2 flex items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        className="accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function FieldRow({
  field,
  onChange,
  onRemove,
}: {
  field: RequestFormField;
  onChange: (patch: Partial<RequestFormField>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mb-2 border border-border-soft p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-40 flex-1"
          required
          maxLength={200}
          aria-label={t('requestForm.settings.fieldLabel')}
          placeholder={t('requestForm.settings.fieldLabel')}
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <select
          className="input w-auto"
          aria-label={t('requestForm.settings.fieldLabel')}
          value={field.type}
          onChange={(e) => onChange({ type: e.target.value as RequestFormFieldType })}
        >
          {REQUEST_FORM_FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`requestForm.settings.type.${type}`)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input
            type="checkbox"
            className="accent-primary"
            checked={field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          {t('requestForm.settings.required')}
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t('requestForm.settings.removeField')}
          title={t('requestForm.settings.removeField')}
          onClick={onRemove}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {field.type === 'select' && (
        <textarea
          className="input mt-2"
          rows={3}
          required
          placeholder={t('requestForm.settings.optionsPlaceholder')}
          value={(field.options ?? []).join('\n')}
          onChange={(e) => onChange({ options: e.target.value.split('\n') })}
        />
      )}
    </div>
  );
}

function Editor({ team, form }: { team: Team; form: RequestForm | null }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['request-form', ws.slug, team.id];
  const [v, setV] = useState({
    enabled: form?.enabled ?? false,
    title: form?.title ?? '',
    intro: form?.intro ?? '',
    fields: form?.fields ?? [],
    templateId: form?.templateId ?? null,
    allowAttachments: form?.allowAttachments ?? false,
    confirmationEmail: form?.confirmationEmail ?? true,
    doneEmail: form?.doneEmail ?? false,
    captchaProvider: form?.captchaProvider ?? null,
    captchaSiteKey: form?.captchaSiteKey ?? '',
    captchaSecret: '',
  });
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const setField = (id: string, patch: Partial<RequestFormField>) =>
    set({ fields: v.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });

  const save = useWsMutation(
    ws.slug,
    () =>
      api.put<RequestForm>(wsPath(ws.slug, `/teams/${team.id}/request-form`), {
        ...v,
        fields: v.fields.map((f) => ({
          ...f,
          options:
            f.type === 'select'
              ? (f.options ?? []).map((o) => o.trim()).filter(Boolean)
              : undefined,
        })),
        captchaSiteKey: v.captchaProvider ? v.captchaSiteKey : null,
        captchaSecret: v.captchaSecret || undefined,
      }),
    { success: t('common.saved'), invalidate: [key] },
  );
  const rotate = useWsMutation(
    ws.slug,
    () => api.post<RequestForm>(wsPath(ws.slug, `/teams/${team.id}/request-form/rotate-link`)),
    { invalidate: [key] },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(undefined, {
      onSuccess: () => {
        set({ captchaSecret: '' });
        qc.invalidateQueries({ queryKey: key });
      },
    });
  };

  const link = form && `${window.location.origin}/request-form/${form.token}`;
  const embed =
    link &&
    `<iframe src="${link}" title="${v.title.replace(/["<>&]/g, '') || t('requestForm.settings.formTitlePlaceholder')}" width="100%" height="800" style="border:0"></iframe>`;
  const templates = ws.templates.filter((tpl) => !tpl.teamId || tpl.teamId === team.id);

  return (
    <form onSubmit={submit} className="max-w-xl">
      {!team.triageEnabled && (
        <p className="mb-4 text-[12.5px] text-muted">{t('requestForm.settings.noTriage')}</p>
      )}
      <Check
        label={t('requestForm.settings.enabled')}
        checked={v.enabled}
        onChange={(enabled) => set({ enabled })}
      />
      {link && embed && (
        <div className="mt-3 mb-4">
          <div className="mb-1 text-[12px] text-muted">{t('requestForm.settings.link')}</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input min-w-40 flex-1 font-mono"
              readOnly
              value={link}
              aria-label={t('requestForm.settings.link')}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(link)}>
              <Copy size={12} /> {t('common.copy')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(embed)}>
              <Copy size={12} /> {t('requestForm.settings.embed')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                const confirmed = await confirmDialog({
                  title: t('requestForm.settings.newLink'),
                  body: t('requestForm.settings.confirmNewLink'),
                  danger: true,
                });
                if (confirmed) rotate.mutate(undefined);
              }}
            >
              <RotateCcw size={12} /> {t('requestForm.settings.newLink')}
            </button>
          </div>
        </div>
      )}
      <div className="mt-4" />
      <FormRow
        label={t('requestForm.settings.formTitle')}
        hint={t('requestForm.settings.formTitleHint')}
      >
        <input
          className="input"
          maxLength={200}
          placeholder={t('requestForm.settings.formTitlePlaceholder')}
          value={v.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </FormRow>
      <FormRow label={t('requestForm.settings.intro')}>
        <textarea
          className="input"
          rows={3}
          maxLength={2000}
          value={v.intro}
          onChange={(e) => set({ intro: e.target.value })}
        />
      </FormRow>

      <div className="mb-1 text-[12px] text-muted">{t('requestForm.settings.fields')}</div>
      <p className="mb-2 text-[11.5px] text-index">{t('requestForm.settings.fieldsHint')}</p>
      {v.fields.map((field) => (
        <FieldRow
          key={field.id}
          field={field}
          onChange={(patch) => setField(field.id, patch)}
          onRemove={() => set({ fields: v.fields.filter((f) => f.id !== field.id) })}
        />
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-sm mb-4"
        disabled={v.fields.length >= 20}
        onClick={() =>
          set({
            fields: [...v.fields, { id: newFieldId(), label: '', type: 'text', required: false }],
          })
        }
      >
        <Plus size={12} /> {t('requestForm.settings.addField')}
      </button>

      <FormRow
        label={t('requestForm.settings.template')}
        hint={t('requestForm.settings.templateHint')}
      >
        <select
          className="input"
          value={v.templateId ?? ''}
          onChange={(e) => set({ templateId: e.target.value || null })}
        >
          <option value="">{t('requestForm.settings.noTemplate')}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
        </select>
      </FormRow>

      <Check
        label={t('requestForm.settings.attachments')}
        checked={v.allowAttachments}
        onChange={(allowAttachments) => set({ allowAttachments })}
      />
      <Check
        label={t('requestForm.settings.confirmation')}
        checked={v.confirmationEmail}
        onChange={(confirmationEmail) => set({ confirmationEmail })}
      />
      <Check
        label={t('requestForm.settings.done')}
        checked={v.doneEmail}
        onChange={(doneEmail) => set({ doneEmail })}
      />

      <div className="mt-4" />
      <FormRow
        label={t('requestForm.settings.captcha')}
        hint={t('requestForm.settings.captchaHint')}
      >
        <select
          className="input"
          value={v.captchaProvider ?? ''}
          onChange={(e) =>
            set({ captchaProvider: (e.target.value || null) as RequestFormCaptchaProvider | null })
          }
        >
          <option value="">{t('requestForm.settings.captchaOff')}</option>
          {REQUEST_FORM_CAPTCHA_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {CAPTCHA_NAMES[p]}
            </option>
          ))}
        </select>
      </FormRow>
      {v.captchaProvider && (
        <>
          <FormRow label={t('requestForm.settings.siteKey')}>
            <input
              className="input font-mono"
              required
              autoComplete="off"
              value={v.captchaSiteKey}
              onChange={(e) => set({ captchaSiteKey: e.target.value })}
            />
          </FormRow>
          <FormRow
            label={t('requestForm.settings.secretKey')}
            hint={form?.captchaSecretSet ? t('requestForm.settings.secretKeep') : undefined}
          >
            <input
              className="input font-mono"
              type="password"
              autoComplete="off"
              required={!form?.captchaSecretSet}
              value={v.captchaSecret}
              onChange={(e) => set({ captchaSecret: e.target.value })}
            />
          </FormRow>
        </>
      )}
      <button className="btn btn-primary mt-2" disabled={save.isPending}>
        {t('common.save')}
      </button>
    </form>
  );
}

/** Team settings → the team's public request form. For team admins, as the API is. */
export function RequestFormCard({ team }: { team: Team }) {
  const ws = useWorkspace();
  const { data } = useQuery({
    queryKey: ['request-form', ws.slug, team.id],
    queryFn: () =>
      api.get<{ form: RequestForm | null }>(wsPath(ws.slug, `/teams/${team.id}/request-form`)),
  });
  return (
    <SettingsCard
      title={t('requestForm.settings.title')}
      description={t('requestForm.settings.description')}
    >
      {/* Remounts once the form exists, or gets a new link, so the editor starts from what's saved. */}
      {data && <Editor key={data.form?.token ?? 'new'} team={team} form={data.form} />}
    </SettingsCard>
  );
}
