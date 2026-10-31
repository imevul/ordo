import type { WorkspaceDomain, WorkspaceSettings } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Globe, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { keys } from '../../../api/queries.ts';
import { t } from '../../../i18n/index.ts';
import { roleLabel } from '../../../i18n/labels.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { errMsg } from './shared.ts';

export function OrgSecuritySection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const settings = ws.workspace.settings;
  const save = async (patch: Partial<WorkspaceSettings>) => {
    try {
      await api.patch(wsPath(ws.slug, '/'), { settings: patch });
      qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  if (!ws.isAdmin)
    return <p className="text-muted">{t('workspaceSettings.security.adminsOnly')}</p>;
  return (
    <>
      <SettingsCard title={t('workspaceSettings.security.invitations')}>
        <label className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
          <span>
            {t('workspaceSettings.security.whoCanInvite')}
            <span className="block text-[12px] text-index">
              {t('workspaceSettings.security.whoCanInviteHint')}
            </span>
          </span>
          <select
            className="input w-48"
            value={settings.invitePolicy}
            onChange={(e) =>
              save({ invitePolicy: e.target.value as WorkspaceSettings['invitePolicy'] })
            }
          >
            <option value="admins">{t('workspaceSettings.security.adminsOnlyOption')}</option>
            <option value="members">{t('workspaceSettings.security.adminsAndMembers')}</option>
          </select>
        </label>
      </SettingsCard>
      <DomainsCard />
      <SettingsCard
        title={t('workspaceSettings.security.joinByDomain')}
        description={t('workspaceSettings.security.joinByDomainDescription')}
      >
        <label className="flex items-center justify-between gap-3 border-b border-border-soft py-2.5 text-[13.5px]">
          {t('workspaceSettings.security.allowJoin')}
          <input
            type="checkbox"
            className="accent-primary"
            checked={settings.domainAutoJoin}
            onChange={(e) => save({ domainAutoJoin: e.target.checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
          {t('workspaceSettings.security.joinAs')}
          <select
            className="input w-40"
            value={settings.autoJoinRole}
            onChange={(e) =>
              save({ autoJoinRole: e.target.value as WorkspaceSettings['autoJoinRole'] })
            }
          >
            <option value="member">{roleLabel('member')}</option>
            <option value="guest">{roleLabel('guest')}</option>
          </select>
        </label>
      </SettingsCard>
    </>
  );
}

function DomainsCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'domains'];
  const { data: domains = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<WorkspaceDomain[]>(wsPath(ws.slug, '/domains')),
  });
  const [domain, setDomain] = useState('');
  const reload = () => qc.invalidateQueries({ queryKey: key });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(wsPath(ws.slug, '/domains'), { domain });
      setDomain('');
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard
      title={t('workspaceSettings.domains.title')}
      description={t('workspaceSettings.domains.description')}
    >
      <form onSubmit={add} className="mb-4 flex gap-2">
        <input
          className="input"
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          required
        />
        <button className="btn btn-primary">
          <Globe size={13} /> {t('common.add')}
        </button>
      </form>
      {domains.map((d) => (
        <div key={d.id} className="border-b border-border-soft py-3">
          <div className="flex items-center gap-3">
            <span className="flex-1 font-mono text-[13px]">{d.domain}</span>
            {d.verified ? (
              <span className="chip [--chip:var(--color-success)]">
                {d.verifiedBy === 'instance_admin'
                  ? t('workspaceSettings.domains.verifiedByAdmin')
                  : t('workspaceSettings.domains.verified')}
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  try {
                    await api.post(wsPath(ws.slug, `/domains/${d.id}/verify`));
                    toast.success(
                      t('workspaceSettings.domains.verifiedToast', { domain: d.domain }),
                    );
                    reload();
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <CheckCircle2 size={12} /> {t('workspaceSettings.domains.verify')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                await api.del(wsPath(ws.slug, `/domains/${d.id}`));
                reload();
              }}
              aria-label={t('workspaceSettings.domains.remove', { domain: d.domain })}
            >
              <Trash2 size={12} />
            </button>
          </div>
          {!d.verified && (
            <div className="mt-2 border border-border-soft bg-bg p-2.5 font-mono text-[11.5px] text-muted">
              TXT <span className="text-text">_ordo-verify.{d.domain}</span> →{' '}
              <span className="text-text">ordo-verify={d.verificationToken}</span>
            </div>
          )}
        </div>
      ))}
      {domains.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('workspaceSettings.domains.empty')}</p>
      )}
    </SettingsCard>
  );
}
