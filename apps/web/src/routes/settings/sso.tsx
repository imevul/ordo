import type { AuthProvider, LinkedIdentity, WorkspaceSettings } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FlaskConical, KeyRound, Link2, Pencil, Plus, Trash2, Unlink } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { keys } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { relativeTime } from '../../lib/format.ts';
import { ssoStartUrl } from '../../lib/sso.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
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

  if (!ws.isAdmin) return <p className="text-muted">Only admins can change sign-in settings.</p>;
  if (!data) return <Spinner />;
  const anyEnabled = data.providers.some((p) => p.enabled);

  return (
    <>
      <SettingsCard
        title="Single sign-on"
        description="Let people sign in with your identity provider (Keycloak, Authentik, Entra ID, Google, Okta… anything that speaks OpenID Connect). New accounts are only created for verified addresses at your verified domains."
      >
        <div className="mb-5 border border-border-soft bg-bg p-3">
          <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
            Redirect URI — register this with your provider
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
                toast.success('Copied');
              }}
            >
              <Copy size={12} /> Copy
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
                  <span className="chip ml-3 [--chip:var(--color-success)]">enabled</span>
                ) : (
                  <span className="tag ml-3 font-mono">disabled</span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-index">{p.issuer}</div>
            </div>
            <a
              className="btn btn-ghost btn-sm"
              href={ssoStartUrl(p.id, { mode: 'test', redirect: here() })}
              title="Sign in with this provider and see the claims it sends"
            >
              <FlaskConical size={12} /> Test
            </a>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditing(p)}
              aria-label={`Edit ${p.name}`}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              aria-label={`Delete ${p.name}`}
              onClick={async () => {
                if (
                  !(await confirmDialog({
                    title: `Delete ${p.name}?`,
                    body: 'People who only sign in with it lose access.',
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
          <p className="font-mono text-[12px] text-index">// no providers yet</p>
        )}
        <button type="button" className="btn btn-primary mt-4" onClick={() => setEditing('new')}>
          <Plus size={13} /> Add provider
        </button>
      </SettingsCard>

      <SettingsCard title="Enforcement">
        <label className="flex items-center justify-between border-b border-border-soft py-2.5 text-[13.5px]">
          <span>
            Require SSO
            <span className="block text-[12px] text-index">
              {anyEnabled
                ? 'Password sessions can no longer open this workspace. Owners keep their password as a fallback; each use is audited.'
                : 'Add and enable a provider first.'}
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
            SSO session length
            <span className="block text-[12px] text-index">
              How long before people go back through your provider.
            </span>
          </span>
          <select
            className="input w-40"
            value={settings.ssoSessionMaxAgeHours ?? ''}
            onChange={(e) =>
              save({ ssoSessionMaxAgeHours: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">Like any session</option>
            <option value="8">8 hours</option>
            <option value="24">1 day</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </select>
        </label>
        <label className="flex items-center justify-between py-2.5 text-[13.5px]">
          <span>
            Allow API keys
            <span className="block text-[12px] text-index">
              When SSO is required, API keys bypass your provider. Off by default.
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
      toast.success(existing ? 'Provider saved' : 'Provider added. Try "Test" next.');
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!provider} onClose={onClose} width={560} label="Sign-in provider" align="center">
      <form className="max-h-[80vh] overflow-y-auto p-6" onSubmit={submit}>
        <div className="section-label mb-4">{existing ? 'Edit provider' : 'New provider'}</div>
        <FormRow label="Name" hint='Shown on the button: "Continue with …"'>
          <input
            className="input"
            required
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Acme ID"
            autoFocus
          />
        </FormRow>
        <FormRow label="Issuer URL" hint="Ordo reads <issuer>/.well-known/openid-configuration.">
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
          <FormRow label="Client ID">
            <input
              className="input font-mono"
              required
              value={form.clientId}
              onChange={(e) => set('clientId', e.target.value)}
            />
          </FormRow>
          <FormRow
            label="Client secret"
            hint={existing ? 'Leave empty to keep the current one.' : undefined}
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
          <FormRow label="Scopes">
            <input
              className="input font-mono"
              value={form.scopes}
              onChange={(e) => set('scopes', e.target.value)}
            />
          </FormRow>
          <FormRow label="New people join as">
            <select
              className="input"
              value={form.defaultRole}
              onChange={(e) => set('defaultRole', e.target.value as 'member' | 'guest')}
            >
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </select>
          </FormRow>
        </div>
        <FormRow
          label="Group claim"
          hint="Optional. A claim listing the user's groups, e.g. groups."
        >
          <input
            className="input font-mono"
            value={form.groupClaim}
            onChange={(e) => set('groupClaim', e.target.value)}
            placeholder="groups"
          />
        </FormRow>
        {form.groupClaim.trim() && (
          <FormRow
            label="Group → role"
            hint="One per line: group = admin | member | guest. Applied at every sign-in; owners are never changed."
          >
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
          Enabled
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {existing ? 'Save' : 'Add provider'}
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
    <SettingsCard
      title="Connected accounts"
      description="Sign-in identities linked to your Ordo account."
    >
      {identities.map((i) => (
        <div key={i.id} className="flex h-12 items-center gap-3 border-b border-border-soft">
          <KeyRound size={14} className="flex-none text-highlight" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px]">
              {i.provider} <span className="text-index">· {i.workspace}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {i.email ?? 'no email'}
              {i.lastLoginAt && ` · last used ${relativeTime(i.lastLoginAt)}`}
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
            <Unlink size={12} /> Unlink
          </button>
        </div>
      ))}
      {identities.length === 0 && (
        <p className="font-mono text-[12px] text-index">// nothing linked</p>
      )}
      {linkable.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {linkable.map((o) => (
            <a
              key={o.providerId}
              className="btn btn-ghost btn-sm"
              href={ssoStartUrl(o.providerId, { mode: 'link', redirect: here() })}
            >
              <Link2 size={12} /> Connect {o.name}
            </a>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
