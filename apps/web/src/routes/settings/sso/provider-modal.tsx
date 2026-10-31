import { type AuthProvider, type SamlSettings, samlServiceProvider } from '@ordo/shared';
import { FileCode2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { Modal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { roleLabel } from '../../../i18n/labels.ts';
import { longDate } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import {
  emptyForm,
  NAMEID_FORMATS,
  rolesToText,
  splitCertificates,
  textToRoles,
} from './provider-form.ts';
import { CopyField, errMsg } from './shared.tsx';

export function ProviderModal({
  provider,
  publicUrl,
  onClose,
  onSaved,
}: {
  provider: AuthProvider | 'new' | null;
  publicUrl: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ws = useWorkspace();
  const existing = provider && provider !== 'new' ? provider : null;
  const [form, setForm] = useState(emptyForm);
  // A new SAML provider's id is chosen here, so its addresses can go to the IdP before saving.
  const [id, setId] = useState('');
  const [metadata, setMetadata] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!provider) return;
    setId(existing?.id ?? crypto.randomUUID());
    setMetadata('');
    const saml = existing?.saml;
    setForm({
      ...emptyForm(),
      protocol: existing?.protocol ?? 'oidc',
      name: existing?.name ?? '',
      issuer: existing?.issuer ?? '',
      clientId: existing?.clientId ?? '',
      scopes: existing?.scopes ?? 'openid email profile',
      idpEntityId: saml?.idpEntityId ?? '',
      ssoUrl: saml?.ssoUrl ?? '',
      certificates: saml?.certificates.join('\n') ?? '',
      nameIdFormat: saml?.nameIdFormat ?? '',
      emailAttribute: saml?.emailAttribute ?? '',
      nameAttribute: saml?.nameAttribute ?? '',
      metadataUrl: saml?.metadataUrl ?? '',
      trustEmail: existing?.trustEmail ?? false,
      enabled: existing?.enabled ?? true,
      defaultRole: existing?.defaultRole ?? 'member',
      groupClaim: existing?.groupClaim ?? '',
      groupRoles: rolesToText(existing?.groupRoles ?? {}),
    });
  }, [provider, existing]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const saml = form.protocol === 'saml';
  const sp = id ? samlServiceProvider(publicUrl, id) : null;
  // The API drops the stored secret when the issuer changes, so a new issuer needs it again.
  const keepsSecret = !!existing && form.issuer.trim() === existing.issuer;

  const readMetadata = async () => {
    const source = metadata.trim();
    if (!source) return;
    try {
      const found = await api.post<SamlSettings & { nameIdFormats: string[] }>(
        wsPath(ws.slug, '/auth-providers/saml/metadata'),
        /^https?:\/\//.test(source) ? { url: source } : { xml: source },
      );
      setForm((f) => ({
        ...f,
        idpEntityId: found.idpEntityId,
        ssoUrl: found.ssoUrl,
        certificates: found.certificates.join('\n'),
        metadataUrl: found.metadataUrl ?? '',
        nameIdFormat: found.nameIdFormats.includes(NAMEID_FORMATS[0]!)
          ? NAMEID_FORMATS[0]!
          : f.nameIdFormat,
      }));
      setMetadata('');
      toast.success(t('sso.provider.metadataRead'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const common = {
      name: form.name,
      enabled: form.enabled,
      defaultRole: form.defaultRole,
      groupClaim: form.groupClaim.trim() || null,
      groupRoles: textToRoles(form.groupRoles),
    };
    const body = saml
      ? {
          ...common,
          trustEmail: form.trustEmail,
          saml: {
            idpEntityId: form.idpEntityId,
            ssoUrl: form.ssoUrl,
            certificates: splitCertificates(form.certificates),
            nameIdFormat: form.nameIdFormat || null,
            emailAttribute: form.emailAttribute || null,
            nameAttribute: form.nameAttribute || null,
            metadataUrl: form.metadataUrl || null,
          },
        }
      : {
          ...common,
          issuer: form.issuer,
          clientId: form.clientId,
          clientSecret: form.clientSecret,
          scopes: form.scopes,
        };
    try {
      if (existing) await api.patch(wsPath(ws.slug, `/auth-providers/${existing.id}`), body);
      else
        await api.post(wsPath(ws.slug, '/auth-providers'), {
          ...body,
          protocol: form.protocol,
          ...(saml && { id }),
        });
      toast.success(existing ? t('sso.provider.saved') : t('sso.provider.added'));
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!provider}
      onClose={onClose}
      width={600}
      label={t('sso.provider.label')}
      align="center"
    >
      <form className="max-h-[80vh] overflow-y-auto p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {existing ? t('sso.provider.edit') : t('sso.provider.new')}
        </div>
        {!existing && (
          <div
            className="mb-4 inline-flex border border-border"
            role="radiogroup"
            aria-label={t('sso.provider.protocol')}
          >
            {(['oidc', 'saml'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={form.protocol === p}
                className={`px-3 py-1.5 font-mono text-[12px] ${form.protocol === p ? 'bg-primary text-on-primary' : 'text-muted hover:text-text'}`}
                onClick={() => set('protocol', p)}
              >
                {t(`sso.provider.${p}`)}
              </button>
            ))}
          </div>
        )}
        <FormRow label={t('sso.provider.name')} hint={t('sso.provider.nameHint')}>
          <input
            className="input"
            required
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Acme ID"
            autoFocus
          />
        </FormRow>
        {saml ? (
          <>
            {sp && (
              <div className="mb-4 border border-border-soft bg-bg p-3">
                <div className="section-label mb-3">{t('sso.provider.spTitle')}</div>
                <CopyField label={t('sso.provider.spEntityId')} value={sp.entityId} />
                <CopyField label={t('sso.provider.spAcs')} value={sp.acsUrl} />
                <CopyField label={t('sso.provider.spMetadata')} value={sp.metadataUrl} />
              </div>
            )}
            <FormRow label={t('sso.provider.metadata')} hint={t('sso.provider.metadataHint')}>
              <div className="flex items-start gap-2">
                <textarea
                  className="input min-h-10 flex-1 font-mono text-[12px]"
                  rows={metadata.includes('<') ? 5 : 1}
                  value={metadata}
                  onChange={(e) => setMetadata(e.target.value)}
                  placeholder="https://idp.example.com/saml/metadata"
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!metadata.trim()}
                  onClick={readMetadata}
                >
                  <FileCode2 size={12} /> {t('sso.provider.readMetadata')}
                </button>
              </div>
            </FormRow>
            <FormRow label={t('sso.provider.idpEntityId')}>
              <input
                className="input font-mono"
                required
                value={form.idpEntityId}
                onChange={(e) => set('idpEntityId', e.target.value)}
              />
            </FormRow>
            <FormRow label={t('sso.provider.ssoUrl')} hint={t('sso.provider.ssoUrlHint')}>
              <input
                className="input font-mono"
                required
                type="url"
                value={form.ssoUrl}
                onChange={(e) => set('ssoUrl', e.target.value)}
              />
            </FormRow>
            <FormRow
              label={t('sso.provider.certificates')}
              hint={t('sso.provider.certificatesHint')}
            >
              <textarea
                className="input min-h-24 font-mono text-[11px]"
                required
                value={form.certificates}
                onChange={(e) => set('certificates', e.target.value)}
                placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
              />
            </FormRow>
            {existing?.saml?.certificateInfo.map((c) => (
              <div
                key={c.fingerprint}
                className="-mt-2 mb-3 truncate font-mono text-[11px] text-index"
              >
                {c.subject} ·{' '}
                {Date.parse(c.notAfter) < Date.now()
                  ? t('sso.provider.certExpired', { date: longDate(c.notAfter) })
                  : t('sso.provider.certExpires', { date: longDate(c.notAfter) })}
              </div>
            ))}
            <FormRow label={t('sso.provider.nameIdFormat')} hint={t('sso.provider.nameIdHint')}>
              <select
                className="input font-mono text-[12px]"
                value={form.nameIdFormat}
                onChange={(e) => set('nameIdFormat', e.target.value)}
              >
                <option value="">{t('sso.provider.nameIdDefault')}</option>
                {[...new Set([...NAMEID_FORMATS, form.nameIdFormat].filter(Boolean))].map((f) => (
                  <option key={f} value={f}>
                    {f.split(':').pop()}
                  </option>
                ))}
              </select>
            </FormRow>
            <div className="grid grid-cols-2 gap-3">
              <FormRow
                label={t('sso.provider.emailAttribute')}
                hint={t('sso.provider.attributeHint')}
              >
                <input
                  className="input font-mono"
                  value={form.emailAttribute}
                  onChange={(e) => set('emailAttribute', e.target.value)}
                  placeholder="email"
                />
              </FormRow>
              <FormRow label={t('sso.provider.nameAttribute')}>
                <input
                  className="input font-mono"
                  value={form.nameAttribute}
                  onChange={(e) => set('nameAttribute', e.target.value)}
                  placeholder="displayName"
                />
              </FormRow>
            </div>
            <label className="mb-4 flex items-start gap-2 text-[13.5px]">
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                checked={form.trustEmail}
                onChange={(e) => set('trustEmail', e.target.checked)}
              />
              <span>
                {t('sso.provider.trustEmail')}
                <span className="block text-[12px] text-index">
                  {t('sso.provider.trustEmailHint')}
                </span>
              </span>
            </label>
          </>
        ) : (
          <>
            <FormRow
              label={t('sso.provider.issuer')}
              hint={t('sso.provider.issuerHint', {
                path: '<issuer>/.well-known/openid-configuration',
              })}
            >
              <input
                className="input font-mono"
                required
                type="url"
                value={form.issuer}
                onChange={(e) => set('issuer', e.target.value)}
                placeholder="https://id.example.com/realms/acme"
              />
            </FormRow>
            <div className="grid grid-cols-2 gap-3">
              <FormRow label={t('sso.provider.clientId')}>
                <input
                  className="input font-mono"
                  required
                  value={form.clientId}
                  onChange={(e) => set('clientId', e.target.value)}
                />
              </FormRow>
              <FormRow
                label={t('sso.provider.clientSecret')}
                hint={keepsSecret ? t('sso.provider.keepSecret') : undefined}
              >
                <input
                  className="input font-mono"
                  type="password"
                  autoComplete="off"
                  required={!keepsSecret}
                  value={form.clientSecret}
                  onChange={(e) => set('clientSecret', e.target.value)}
                />
              </FormRow>
            </div>
            <FormRow label={t('sso.provider.scopes')}>
              <input
                className="input font-mono"
                value={form.scopes}
                onChange={(e) => set('scopes', e.target.value)}
              />
            </FormRow>
          </>
        )}
        <FormRow label={t('sso.provider.joinAs')}>
          <select
            className="input"
            value={form.defaultRole}
            onChange={(e) => set('defaultRole', e.target.value as 'member' | 'guest')}
          >
            <option value="member">{roleLabel('member')}</option>
            <option value="guest">{roleLabel('guest')}</option>
          </select>
        </FormRow>
        <FormRow
          label={saml ? t('sso.provider.groupAttribute') : t('sso.provider.groupClaim')}
          hint={saml ? t('sso.provider.groupAttributeHint') : t('sso.provider.groupClaimHint')}
        >
          <input
            className="input font-mono"
            value={form.groupClaim}
            onChange={(e) => set('groupClaim', e.target.value)}
            placeholder="groups"
          />
        </FormRow>
        {form.groupClaim.trim() && (
          <FormRow label={t('sso.provider.groupRoles')} hint={t('sso.provider.groupRolesHint')}>
            <textarea
              className="input min-h-20 font-mono"
              value={form.groupRoles}
              onChange={(e) => set('groupRoles', e.target.value)}
              placeholder={'ordo-admins = admin\ncontractors = guest'}
            />
          </FormRow>
        )}
        <label className="flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            className="accent-primary"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          {t('sso.provider.enabled')}
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {existing ? t('common.save') : t('sso.addProvider')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
