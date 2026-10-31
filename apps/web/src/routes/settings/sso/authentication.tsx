import type { AuthProvider, WorkspaceSettings } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, KeyRound, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { keys } from '../../../api/queries.ts';
import { Spinner } from '../../../components/PageHeader.tsx';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { relativeTime } from '../../../lib/format.ts';
import { ssoStartUrl } from '../../../lib/sso.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { DirectoryGroupsCard, DirectorySyncCard } from './directory.tsx';
import { ProviderModal } from './provider-modal.tsx';
import { CopyField, errMsg, here, useRedirectError } from './shared.tsx';

// ─── Org → Authentication ──────────────────────────────────────────────

interface ProvidersResponse {
  providers: AuthProvider[];
  redirectUri: string;
  publicUrl: string;
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
