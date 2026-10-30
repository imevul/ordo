import {
  type AuthProvider,
  type LinkedIdentity,
  type SamlSettings,
  type ScimGroup,
  type ScimLinkPreview,
  type ScimToken,
  samlServiceProvider,
  type WorkspaceSettings,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  FileCode2,
  FlaskConical,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Unlink,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { keys } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { roleLabel } from '../../i18n/labels.ts';
import { longDate, relativeTime } from '../../lib/format.ts';
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
  publicUrl: string;
}

const copy = (text: string) => {
  navigator.clipboard.writeText(text);
  toast.success(t('common.copied'));
};

/** A value to hand to the identity provider, with a copy button. */
function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all text-text">{value}</code>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(value)}>
          <Copy size={12} /> {t('common.copy')}
        </button>
      </div>
    </div>
  );
}

const SOON = 30 * 86_400_000;
/** The first signing certificate that has expired or will within a month, if any. */
const expiringCert = (p: AuthProvider) =>
  p.saml?.certificateInfo
    .filter((c) => c.notAfter && Date.parse(c.notAfter) - Date.now() < SOON)
    .sort((a, b) => a.notAfter.localeCompare(b.notAfter))[0];

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
          <CopyField label={t('sso.redirectUri')} value={data.redirectUri} />
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
              <div className="truncate font-mono text-[11px] text-index">
                <span className="mr-2 text-muted">{p.protocol === 'saml' ? 'SAML' : 'OIDC'}</span>
                {p.protocol === 'saml' ? p.saml?.idpEntityId : p.issuer}
              </div>
              {expiringCert(p) && (
                <div className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-warning">
                  <TriangleAlert size={11} />
                  {t('sso.certExpiring', { time: relativeTime(expiringCert(p)!.notAfter) })}
                </div>
              )}
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

      <DirectorySyncCard
        defaultRole={settings.scimDefaultRole}
        onDefaultRole={(scimDefaultRole) => save({ scimDefaultRole })}
      />
      <DirectoryGroupsCard
        matchByName={settings.scimMatchGroupsByName}
        onMatchByName={(scimMatchGroupsByName) => save({ scimMatchGroupsByName })}
      />

      <ProviderModal
        provider={editing}
        publicUrl={data.publicUrl}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}

// ─── Org → Authentication → Directory sync ─────────────────────────────

interface TokensResponse {
  tokens: ScimToken[];
  baseUrl: string;
}

function DirectorySyncCard({
  defaultRole,
  onDefaultRole,
}: {
  defaultRole: 'member' | 'guest';
  onDefaultRole: (role: 'member' | 'guest') => void;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'scim-tokens'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<TokensResponse>(wsPath(ws.slug, '/scim/tokens')),
  });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: key });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<ScimToken & { token: string }>(wsPath(ws.slug, '/scim/tokens'), {
        name,
      });
      setFresh(res.token);
      setName('');
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const revoke = async (token: ScimToken) => {
    const ok = await confirmDialog({
      title: t('sso.scim.revokeTitle', { name: token.name }),
      body: t('sso.scim.revokeBody'),
      confirmLabel: t('sso.scim.revoke'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(wsPath(ws.slug, `/scim/tokens/${token.id}`));
      setFresh(null);
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard title={t('sso.scim.title')} description={t('sso.scim.description')}>
      {data && (
        <div className="mb-4 border border-border-soft bg-bg p-3">
          <CopyField label={t('sso.scim.baseUrl')} value={data.baseUrl} />
        </div>
      )}
      {fresh && (
        <div className="panel panel-sm mb-4 p-4 [--panel-border:var(--color-primary)]">
          <p className="mb-2 text-[13px]">{t('sso.scim.copyNow')}</p>
          <CopyField label="Bearer" value={fresh} />
        </div>
      )}
      {data?.tokens.map((token) => (
        <div
          key={token.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft py-2.5 text-[13px]"
        >
          <KeyRound size={14} className="flex-none text-index" />
          <span className="min-w-24 flex-1 truncate">{token.name}</span>
          <code className="font-mono text-[11px] text-index">{token.prefix}…</code>
          <span className="font-mono text-[11px] text-index">
            {token.lastUsedAt
              ? t('sso.scim.lastUsed', { time: relativeTime(token.lastUsedAt) })
              : t('sso.scim.neverUsed')}
            {token.createdBy && ` · ${t('sso.scim.createdBy', { name: token.createdBy })}`}
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            aria-label={t('sso.scim.revokeLabel', { name: token.name })}
            onClick={() => revoke(token)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {data?.tokens.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('sso.scim.empty')}</p>
      )}
      <form onSubmit={create} className="mt-4 flex flex-wrap gap-2">
        <input
          className="input min-w-0 flex-1 sm:max-w-64"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('sso.scim.tokenName')}
          aria-label={t('sso.scim.tokenName')}
        />
        <button className="btn btn-primary">
          <Plus size={13} /> {t('sso.scim.create')}
        </button>
      </form>
      <label className="mt-5 flex items-center justify-between border-t border-border-soft pt-4 text-[13.5px]">
        {t('sso.scim.defaultRole')}
        <select
          className="input w-40"
          value={defaultRole}
          onChange={(e) => onDefaultRole(e.target.value as 'member' | 'guest')}
        >
          <option value="member">{roleLabel('member')}</option>
          <option value="guest">{roleLabel('guest')}</option>
        </select>
      </label>
    </SettingsCard>
  );
}

/** Directory groups, and the teams they decide. Linking shows who'd join and leave first. */
function DirectoryGroupsCard({
  matchByName,
  onMatchByName,
}: {
  matchByName: boolean;
  onMatchByName: (on: boolean) => void;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'scim-groups'];
  const { data: groups = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<ScimGroup[]>(wsPath(ws.slug, '/scim/groups')),
  });

  const link = async (group: ScimGroup, teamId: string | null) => {
    try {
      if (teamId) {
        const team = ws.teamById.get(teamId);
        const preview = await api.post<ScimLinkPreview>(
          wsPath(ws.slug, `/scim/groups/${group.id}/preview`),
          { teamId },
        );
        const names = (people: { name: string }[]) => people.map((p) => p.name).join(', ');
        const ok = await confirmDialog({
          title: t('sso.scim.linkTitle', { group: group.displayName, team: team?.name ?? '' }),
          body: (
            <>
              {preview.add.length > 0 && (
                <p>{t('sso.scim.joins', { names: names(preview.add) })}</p>
              )}
              {preview.remove.length > 0 && (
                <p className="mt-1">{t('sso.scim.leaves', { names: names(preview.remove) })}</p>
              )}
              {!preview.add.length && !preview.remove.length && <p>{t('sso.scim.noChange')}</p>}
            </>
          ),
          confirmLabel: t('sso.scim.link'),
          danger: preview.remove.length > 0,
        });
        if (!ok) return;
      }
      await api.put(wsPath(ws.slug, `/scim/groups/${group.id}/team`), { teamId });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <SettingsCard title={t('sso.scim.groups')} description={t('sso.scim.groupsHint')}>
      <label className="mb-3 flex items-center justify-between gap-3 border-b border-border-soft pb-3 text-[13.5px]">
        {t('sso.scim.matchByName')}
        <input
          type="checkbox"
          className="accent-primary"
          checked={matchByName}
          onChange={(e) => onMatchByName(e.target.checked)}
        />
      </label>
      {groups.map((g) => (
        <div
          key={g.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft py-2.5 text-[13px]"
        >
          <span className="min-w-24 flex-1 truncate">{g.displayName}</span>
          <span className="font-mono text-[11px] text-index">
            {t('sso.scim.memberCount', { count: g.memberCount })}
          </span>
          <select
            className="input h-8 w-44 py-0 text-[12.5px]"
            value={g.teamId ?? ''}
            aria-label={t('sso.scim.teamOf', { group: g.displayName })}
            onChange={(e) => link(g, e.target.value || null)}
          >
            <option value="">{t('sso.scim.notLinked')}</option>
            {ws.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
      ))}
      {groups.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('sso.scim.noGroups')}</p>
      )}
    </SettingsCard>
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

const NAMEID_FORMATS = [
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
];

/** Certificates as pasted: PEM blocks, or one bare base64 body. */
const splitCertificates = (text: string) => {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  return blocks ?? (text.trim() ? [text.trim()] : []);
};

const emptyForm = () => ({
  protocol: 'oidc' as 'oidc' | 'saml',
  name: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  idpEntityId: '',
  ssoUrl: '',
  certificates: '',
  nameIdFormat: '',
  emailAttribute: '',
  nameAttribute: '',
  metadataUrl: '',
  trustEmail: false,
  enabled: true,
  defaultRole: 'member' as 'member' | 'guest',
  groupClaim: '',
  groupRoles: '',
});

function ProviderModal({
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
            <button
              type="button"
              key={o.providerId}
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                try {
                  const { url } = await api.post<{ url: string }>(
                    `/auth/sso/${encodeURIComponent(o.providerId)}/link`,
                    { redirect: here() },
                  );
                  window.location.assign(url);
                } catch (err) {
                  toast.error(errMsg(err));
                }
              }}
            >
              <Link2 size={12} /> {t('sso.connected.connect', { name: o.name })}
            </button>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
