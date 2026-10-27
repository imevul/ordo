import type { AuthProvider, LinkedIdentity, WorkspaceSettings } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FlaskConical, KeyRound, Link2, Pencil, Plus, Trash2, Unlink } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { keys } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { roleLabel } from '../../i18n/labels.ts';
import { relativeTime } from '../../lib/format.ts';
import { ssoStartUrl } from '../../lib/sso.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));
const here = () => window.location.pathname;

/** `?error=` left by an OIDC redirect (link or test mode) is shown once, then dropped. */
function useRedirectError() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    if (!error) return;
    toast.error(error);
    url.searchParams.delete('error');
    window.history.replaceState(null, '', url);
  }, []);
}

// ─── Org → Authentication ──────────────────────────────────────────────

interface ProvidersResponse {
  providers: AuthProvider[];
  redirectUri: string;
}

export function AuthenticationSection() {
  useRedirectError();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'auth-providers'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<ProvidersResponse>(wsPath(ws.slug, '/auth-providers')),
    enabled: ws.isAdmin,
  });
  const [editing, setEditing] = useState<AuthProvider | 'new' | null>(null);
  const settings = ws.workspace.settings;
  const reload = () => qc.invalidateQueries({ queryKey: key });
  const save = async (patch: Partial<WorkspaceSettings>) => {
    try {
      await api.patch(wsPath(ws.slug, '/'), { settings: patch });
      qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  if (!ws.isAdmin) return <p className="text-muted">{t('sso.adminsOnly')}</p>;
  if (!data) return <Spinner />;
  const anyEnabled = data.providers.some((p) => p.enabled);

  return (
    <>
      <SettingsCard title={t('sso.title')} description={t('sso.description')}>
        <div className="mb-5 border border-border-soft bg-bg p-3">
          <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
            {t('sso.redirectUri')}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-[12.5px] text-text">
              {data.redirectUri}
            </code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                navigator.clipboard.writeText(data.redirectUri);
                toast.success(t('common.copied'));
              }}
            >
              <Copy size={12} /> {t('common.copy')}
            </button>
          </div>
        </div>
        {data.providers.map((p) => (
          <div key={p.id} className="flex items-center gap-3 border-b border-border-soft py-3">
            <KeyRound size={14} className="flex-none text-highlight" />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px]">
                {p.name}
                {p.enabled ? (
                  <span className="chip ml-3 [--chip:var(--color-success)]">
                    {t('sso.enabled')}
                  </span>
                ) : (
                  <span className="tag ml-3 font-mono">{t('sso.disabled')}</span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-index">{p.issuer}</div>
            </div>
            <a
              className="btn btn-ghost btn-sm"
              href={ssoStartUrl(p.id, { mode: 'test', redirect: here() })}
              title={t('sso.testTitle')}
            >
              <FlaskConical size={12} /> {t('sso.test')}
            </a>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditing(p)}
              aria-label={t('sso.editLabel', { name: p.name })}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              aria-label={t('sso.deleteLabel', { name: p.name })}
              onClick={async () => {
                if (
                  !(await confirmDialog({
                    title: t('sso.confirmDelete', { name: p.name }),
                    body: t('sso.confirmDeleteBody'),
                    danger: true,
                  }))
                )
                  return;
                await api.del(wsPath(ws.slug, `/auth-providers/${p.id}`));
                reload();
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {data.providers.length === 0 && (
          <p className="font-mono text-[12px] text-index">{t('sso.empty')}</p>
        )}
        <button type="button" className="btn btn-primary mt-4" onClick={() => setEditing('new')}>
          <Plus size={13} /> {t('sso.addProvider')}
        </button>
      </SettingsCard>

      <SettingsCard title={t('sso.enforcement.title')}>
        <label className="flex items-center justify-between border-b border-border-soft py-2.5 text-[13.5px]">
          <span>
            {t('sso.enforcement.requireSso')}
            <span className="block text-[12px] text-index">
              {anyEnabled ? t('sso.enforcement.requireSsoHint') : t('sso.enforcement.enableFirst')}
            </span>
          </span>
          <input
            type="checkbox"
            className="accent-primary"
            disabled={!anyEnabled && !settings.requireSso}
            checked={settings.requireSso}
            onChange={(e) => save({ requireSso: e.target.checked })}
          />
        </label>
        <label className="flex items-center justify-between border-b border-border-soft py-2.5 text-[13.5px]">
          <span>
            {t('sso.enforcement.sessionLength')}
            <span className="block text-[12px] text-index">
              {t('sso.enforcement.sessionLengthHint')}
            </span>
          </span>
          <select
            className="input w-40"
            value={settings.ssoSessionMaxAgeHours ?? ''}
            onChange={(e) =>
              save({ ssoSessionMaxAgeHours: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">{t('sso.enforcement.likeAnySession')}</option>
            <option value="8">{t('sso.enforcement.hours', { count: 8 })}</option>
            <option value="24">{t('sso.enforcement.days', { count: 1 })}</option>
            <option value="168">{t('sso.enforcement.days', { count: 7 })}</option>
            <option value="720">{t('sso.enforcement.days', { count: 30 })}</option>
          </select>
        </label>
        <label className="flex items-center justify-between py-2.5 text-[13.5px]">
          <span>
            {t('sso.enforcement.allowApiKeys')}
            <span className="block text-[12px] text-index">
              {t('sso.enforcement.allowApiKeysHint')}
            </span>
          </span>
          <input
            type="checkbox"
            className="accent-primary"
            checked={settings.allowApiKeysUnderSso}
            onChange={(e) => save({ allowApiKeysUnderSso: e.target.checked })}
          />
        </label>
      </SettingsCard>

      <ProviderModal
        provider={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}

const rolesToText = (roles: Record<string, string>) =>
  Object.entries(roles)
    .map(([group, role]) => `${group} = ${role}`)
    .join('\n');

function textToRoles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [group, role] = line.split('=').map((s) => s.trim());
    if (group && role) out[group] = role;
  }
  return out;
}

function ProviderModal({
  provider,
  onClose,
  onSaved,
}: {
  provider: AuthProvider | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ws = useWorkspace();
  const existing = provider && provider !== 'new' ? provider : null;
  const [form, setForm] = useState({
    name: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    scopes: 'openid email profile',
    enabled: true,
    defaultRole: 'member' as 'member' | 'guest',
    groupClaim: '',
    groupRoles: '',
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!provider) return;
    setForm({
      name: existing?.name ?? '',
      issuer: existing?.issuer ?? '',
      clientId: existing?.clientId ?? '',
      clientSecret: '',
      scopes: existing?.scopes ?? 'openid email profile',
      enabled: existing?.enabled ?? true,
      defaultRole: existing?.defaultRole ?? 'member',
      groupClaim: existing?.groupClaim ?? '',
      groupRoles: rolesToText(existing?.groupRoles ?? {}),
    });
  }, [provider, existing]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const body = {
      ...form,
      groupClaim: form.groupClaim.trim() || null,
      groupRoles: textToRoles(form.groupRoles),
    };
    try {
      if (existing) await api.patch(wsPath(ws.slug, `/auth-providers/${existing.id}`), body);
      else await api.post(wsPath(ws.slug, '/auth-providers'), body);
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
      width={560}
      label={t('sso.provider.label')}
      align="center"
    >
      <form className="max-h-[80vh] overflow-y-auto p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {existing ? t('sso.provider.edit') : t('sso.provider.new')}
        </div>
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
        <FormRow
          label={t('sso.provider.issuer')}
          hint={t('sso.provider.issuerHint', { path: '<issuer>/.well-known/openid-configuration' })}
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
            hint={existing ? t('sso.provider.keepSecret') : undefined}
          >
            <input
              className="input font-mono"
              type="password"
              autoComplete="off"
              required={!existing}
              value={form.clientSecret}
              onChange={(e) => set('clientSecret', e.target.value)}
            />
          </FormRow>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label={t('sso.provider.scopes')}>
            <input
              className="input font-mono"
              value={form.scopes}
              onChange={(e) => set('scopes', e.target.value)}
            />
          </FormRow>
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
        </div>
        <FormRow label={t('sso.provider.groupClaim')} hint={t('sso.provider.groupClaimHint')}>
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

// ─── Account → Connected accounts ──────────────────────────────────────

export function ConnectedAccountsCard() {
  useRedirectError();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['me', 'identities'];
  const { data: identities = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<LinkedIdentity[]>('/me/identities'),
  });
  const { data: options } = useQuery({
    queryKey: ['auth-providers', ws.slug],
    queryFn: () =>
      api.get<{ options: { providerId: string; name: string }[] }>(
        `/auth/providers?workspace=${encodeURIComponent(ws.slug)}`,
      ),
  });
  const linked = new Set(identities.map((i) => `${i.workspace}:${i.provider}`));
  const linkable = (options?.options ?? []).filter(
    (o) => !linked.has(`${ws.workspace.name}:${o.name}`),
  );
  return (
    <SettingsCard title={t('sso.connected.title')} description={t('sso.connected.description')}>
      {identities.map((i) => (
        <div key={i.id} className="flex h-12 items-center gap-3 border-b border-border-soft">
          <KeyRound size={14} className="flex-none text-highlight" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px]">
              {i.provider} <span className="text-index">· {i.workspace}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {i.email ?? t('sso.connected.noEmail')}
              {i.lastLoginAt &&
                ` · ${t('sso.connected.lastUsed', { time: relativeTime(i.lastLoginAt) })}`}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              try {
                await api.del(`/me/identities/${i.id}`);
                qc.invalidateQueries({ queryKey: key });
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <Unlink size={12} /> {t('sso.connected.unlink')}
          </button>
        </div>
      ))}
      {identities.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('sso.connected.empty')}</p>
      )}
      {linkable.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {linkable.map((o) => (
            <a
              key={o.providerId}
              className="btn btn-ghost btn-sm"
              href={ssoStartUrl(o.providerId, { mode: 'link', redirect: here() })}
            >
              <Link2 size={12} /> {t('sso.connected.connect', { name: o.name })}
            </a>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
