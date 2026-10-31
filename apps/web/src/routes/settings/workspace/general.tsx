import { branchName } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Upload } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, upload, wsPath } from '../../../api/client.ts';
import { keys } from '../../../api/queries.ts';
import { TeamIcon } from '../../../components/icons.tsx';
import { t, tx } from '../../../i18n/index.ts';
import { memberChoices, useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow, SettingsCard } from '../ui.tsx';
import { AccentCard } from './accent.tsx';
import { DangerZone } from './danger.tsx';
import { errMsg } from './shared.ts';

export function WorkspaceSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(ws.workspace.name);
  const [slug, setSlug] = useState(ws.workspace.slug);
  const fileRef = useRef<HTMLInputElement>(null);
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
    qc.invalidateQueries({ queryKey: keys.me });
  };

  if (!ws.isAdmin) return <p className="text-muted">{t('workspaceSettings.general.adminsOnly')}</p>;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(wsPath(ws.slug, '/'), { name, slug });
      toast.success(t('workspaceSettings.general.saved'));
      if (slug !== ws.slug)
        navigate({ to: '/$slug/settings/$section', params: { slug, section: 'workspace' } });
      refresh();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const setDefaultTeam = async (teamId: string) => {
    await api.patch(wsPath(ws.slug, '/'), { defaultTeamId: teamId === 'none' ? null : teamId });
    refresh();
  };

  return (
    <>
      <SettingsCard title={t('workspaceSettings.general.title')}>
        <div className="mb-5 flex items-center gap-4">
          {ws.workspace.logoUrl ? (
            <img src={ws.workspace.logoUrl} alt="" className="h-12 w-12 object-cover" />
          ) : (
            <TeamIcon color="var(--color-primary)" label={ws.workspace.name} size={48} />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={12} /> {t('workspaceSettings.general.uploadLogo')}
            </button>
            {ws.workspace.logoUrl && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  await api.del(wsPath(ws.slug, '/logo'));
                  refresh();
                }}
              >
                {t('common.remove')}
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                await upload(wsPath(ws.slug, '/logo'), file, file.name);
                refresh();
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          />
        </div>
        <form onSubmit={save}>
          <FormRow label={t('workspaceSettings.general.name')}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </FormRow>
          <FormRow
            label={t('workspaceSettings.general.url')}
            hint={t('workspaceSettings.general.urlHint')}
          >
            <div className="flex items-center border border-border bg-bg focus-within:border-primary">
              <span className="pl-3 font-mono text-[12px] text-index">{location.host}/</span>
              <input
                className="h-9 min-w-0 flex-1 bg-transparent pr-3 outline-none"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                required
              />
            </div>
          </FormRow>
          <button className="btn btn-primary">{t('common.save')}</button>
        </form>
      </SettingsCard>

      <SettingsCard
        title={t('workspaceSettings.defaultTeam.title')}
        description={t('workspaceSettings.defaultTeam.description')}
      >
        <select
          className="input w-72"
          value={ws.workspace.defaultTeamId ?? 'none'}
          onChange={(e) => setDefaultTeam(e.target.value)}
        >
          <option value="none">{t('common.none')}</option>
          {ws.teams
            .filter((team) => !team.private)
            .map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
        </select>
      </SettingsCard>

      <SettingsCard
        title={t('workspaceSettings.defaultAssignee.title')}
        description={t('workspaceSettings.defaultAssignee.description')}
      >
        <select
          className="input w-72"
          value={ws.workspace.settings.defaultAssigneeId ?? 'none'}
          onChange={async (e) => {
            try {
              await api.patch(wsPath(ws.slug, '/'), {
                settings: { defaultAssigneeId: e.target.value === 'none' ? null : e.target.value },
              });
              refresh();
            } catch (err) {
              toast.error(errMsg(err));
            }
          }}
        >
          <option value="none">{t('issues.none.assignee')}</option>
          {memberChoices(ws).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </SettingsCard>

      <SettingsCard
        title={t('workspaceSettings.timeZone.title')}
        description={t('workspaceSettings.timeZone.description')}
      >
        <select
          className="input w-72"
          value={ws.workspace.settings.timezone ?? ''}
          onChange={async (e) => {
            try {
              await api.patch(wsPath(ws.slug, '/'), {
                settings: { timezone: e.target.value || null },
              });
              refresh();
            } catch (err) {
              toast.error(errMsg(err));
            }
          }}
        >
          <option value="">{t('workspaceSettings.timeZone.utc')}</option>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </SettingsCard>

      <SettingsCard
        title={t('timeTracking.setting.title')}
        description={t('timeTracking.setting.description')}
      >
        <label className="flex items-center justify-between gap-3 py-1 text-[13.5px]">
          {t('timeTracking.setting.enable')}
          <input
            type="checkbox"
            className="accent-primary"
            checked={ws.workspace.settings.timeTracking}
            onChange={async (e) => {
              try {
                await api.patch(wsPath(ws.slug, '/'), {
                  settings: { timeTracking: e.target.checked },
                });
                refresh();
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          />
        </label>
      </SettingsCard>

      <AccentCard />

      <BranchFormatCard />

      {ws.isOwner && <DangerZone />}
    </>
  );
}

function BranchFormatCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [format, setFormat] = useState(ws.workspace.settings.gitBranchFormat);
  const example = branchName(format, {
    identifier: 'ENG-42',
    title: t('workspaceSettings.branch.exampleTitle'),
    username: ws.me.username,
  });
  return (
    <SettingsCard
      title={t('workspaceSettings.branch.title')}
      description={tx('workspaceSettings.branch.description', {
        identifier: <code className="font-mono">{'{identifier}'}</code>,
        title: <code className="font-mono">{'{title}'}</code>,
        username: <code className="font-mono">{'{username}'}</code>,
      })}
    >
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.patch(wsPath(ws.slug, '/'), { settings: { gitBranchFormat: format } });
            qc.invalidateQueries({ queryKey: keys.bootstrap(ws.slug) });
            toast.success(t('common.saved'));
          } catch (err) {
            toast.error(errMsg(err));
          }
        }}
      >
        <input
          className="input w-72 font-mono"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          aria-label={t('workspaceSettings.branch.formatLabel')}
        />
        <button className="btn btn-primary">{t('common.save')}</button>
      </form>
      <p className="mt-2 font-mono text-[11.5px] text-index">→ {example}</p>
    </SettingsCard>
  );
}
