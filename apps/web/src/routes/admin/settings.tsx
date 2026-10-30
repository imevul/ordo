import {
  type AiSettings,
  type InstanceSettingEntry,
  OFFLINE_SYNC_MODES,
  type OfflineSyncMode,
  WORKSPACE_AI_POLICIES,
  type WorkspaceAiPolicy,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { t } from '../../i18n/index.ts';
import { AiCard } from './ai.tsx';
import { Card, errMsg } from './ui.tsx';

export function Settings() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<InstanceSettingEntry[]>('/admin/settings'),
  });
  const [smtpUrl, setSmtpUrl] = useState('');
  const [smtpFrom, setSmtpFrom] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  if (!data) return <Spinner />;
  const entry = <K extends InstanceSettingEntry['key']>(k: K) => data.find((e) => e.key === k)!;
  const locked = (k: InstanceSettingEntry['key']) => entry(k).source === 'env';
  const save = async (patch: object) => {
    try {
      await api.patch('/admin/settings', patch);
      qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      qc.invalidateQueries({ queryKey: ['config'] });
      toast.success(t('common.saved'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const smtp = entry('smtp').value as { url: string | null; from: string } | null;
  const lockedTag = (k: InstanceSettingEntry['key']) =>
    locked(k) ? <span className="tag ml-2 font-mono">{t('admin.settings.setByEnv')}</span> : null;

  const saveSmtp = (e: FormEvent) => {
    e.preventDefault();
    save({ smtp: { url: smtpUrl, from: smtpFrom ?? smtp?.from ?? '' } });
    setSmtpUrl('');
  };

  return (
    <>
      <Card title={t('admin.settings.signup')}>
        <label className="flex items-center justify-between border-b border-border-soft py-3 text-[13.5px]">
          <span>
            {t('admin.settings.signupMode')}
            {lockedTag('signupMode')}
          </span>
          <select
            className="input w-56"
            disabled={locked('signupMode')}
            value={entry('signupMode').value as string}
            onChange={(e) => save({ signupMode: e.target.value })}
          >
            <option value="invite">{t('admin.settings.inviteOnly')}</option>
            <option value="open">{t('admin.settings.anyone')}</option>
          </select>
        </label>
        <label className="flex items-center justify-between py-3 text-[13.5px]">
          <span>
            {t('admin.settings.allowWorkspaceCreation')}
            {lockedTag('allowWorkspaceCreation')}
          </span>
          <input
            type="checkbox"
            className="accent-primary"
            disabled={locked('allowWorkspaceCreation')}
            checked={entry('allowWorkspaceCreation').value as boolean}
            onChange={(e) => save({ allowWorkspaceCreation: e.target.checked })}
          />
        </label>
      </Card>

      <Card
        title={t('admin.settings.offline.title')}
        description={t('admin.settings.offline.description')}
      >
        <label className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1 text-[13.5px]">
          <span className="min-w-0 flex-1">
            {t('admin.settings.offline.label')}
            {lockedTag('offlineSync')}
          </span>
          <select
            className="input w-72 max-w-full"
            disabled={locked('offlineSync')}
            value={entry('offlineSync').value as OfflineSyncMode}
            onChange={(e) => save({ offlineSync: e.target.value })}
          >
            {OFFLINE_SYNC_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`admin.settings.offline.${m}`)}
              </option>
            ))}
          </select>
        </label>
      </Card>

      <Card title={t('admin.settings.email')} description={t('admin.settings.emailDescription')}>
        {locked('smtp') ? (
          <p className="font-mono text-[12.5px] text-muted">
            {t('admin.settings.smtpFromEnv', { url: smtp?.url ?? '' })} {lockedTag('smtp')}
          </p>
        ) : (
          <form onSubmit={saveSmtp}>
            {smtp &&
              (entry('smtp').unreadable ? (
                <p className="mb-3 text-[12.5px] text-error">
                  {t('admin.settings.smtpUnreadable')}
                </p>
              ) : (
                <p className="mb-3 font-mono text-[12px] text-muted">
                  {t('admin.settings.current', { url: smtp.url ?? '' })}
                </p>
              ))}
            <div className="grid gap-2 md:grid-cols-[1fr_16rem_auto]">
              <input
                className="input"
                placeholder={
                  smtp
                    ? t('admin.settings.newSmtpUrl')
                    : 'smtps://user:password@smtp.example.com:465'
                }
                value={smtpUrl}
                onChange={(e) => setSmtpUrl(e.target.value)}
              />
              <input
                className="input"
                placeholder="Ordo <ordo@example.com>"
                value={smtpFrom ?? smtp?.from ?? ''}
                onChange={(e) => setSmtpFrom(e.target.value)}
                required
              />
              <button className="btn btn-primary">{t('common.save')}</button>
            </div>
            {smtp && (
              <button
                type="button"
                className="btn btn-danger btn-sm mt-3"
                onClick={() => save({ smtp: null })}
              >
                {t('admin.settings.turnEmailOff')}
              </button>
            )}
          </form>
        )}
        {smtp && (
          <form
            className="mt-5 flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.post('/admin/settings/test-email', { to: testTo });
                toast.success(t('admin.settings.testSent', { to: testTo }));
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <input
              className="input w-72 max-w-full"
              type="email"
              placeholder="you@example.com"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              required
            />
            <button className="btn btn-ghost">{t('admin.settings.sendTest')}</button>
          </form>
        )}
      </Card>

      <Card title={t('admin.settings.network')}>
        <label className="flex items-center justify-between py-3 text-[13.5px]">
          <span>
            {t('admin.settings.allowPrivate')}
            {lockedTag('allowPrivateNetworkTargets')}
            <span className="block text-[12px] text-index">
              {t('admin.settings.allowPrivateHelp')}
            </span>
          </span>
          <input
            type="checkbox"
            className="accent-primary"
            disabled={locked('allowPrivateNetworkTargets')}
            checked={entry('allowPrivateNetworkTargets').value as boolean}
            onChange={(e) => save({ allowPrivateNetworkTargets: e.target.checked })}
          />
        </label>
      </Card>

      <Card title={t('admin.settings.uploads')}>
        <label className="flex items-center justify-between gap-4 py-3 text-[13.5px]">
          <span>
            {t('admin.settings.maxAttachment')}
            {lockedTag('maxAttachmentMb')}
            <span className="block text-[12px] text-index">
              {t('admin.settings.maxAttachmentHelp')}
            </span>
          </span>
          <span className="flex flex-none items-center gap-2">
            <input
              key={entry('maxAttachmentMb').value as number}
              className="input w-24 text-right font-mono"
              type="number"
              min={1}
              max={1024}
              disabled={locked('maxAttachmentMb')}
              defaultValue={entry('maxAttachmentMb').value as number}
              onBlur={(e) => {
                const mb = Number(e.target.value);
                if (Number.isInteger(mb) && mb >= 1 && mb !== entry('maxAttachmentMb').value)
                  save({ maxAttachmentMb: mb });
              }}
              aria-describedby="max-attachment-unit"
            />
            <span id="max-attachment-unit" className="font-mono text-[12px] text-index">
              {t('admin.settings.megabytes')}
            </span>
          </span>
        </label>
      </Card>

      <AiCard
        // Starts over from what's saved after every save.
        key={JSON.stringify(entry('ai').value)}
        value={entry('ai').value as AiSettings | null}
        locked={locked('ai')}
        unreadable={!!entry('ai').unreadable}
        save={save}
      />
      <Card title={t('admin.ai.workspacesTitle')}>
        <label className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1 text-[13.5px]">
          <span className="min-w-0 flex-1">
            {t('admin.ai.workspaces')}
            {lockedTag('workspaceAi')}
            <span className="block text-[12px] text-index">{t('admin.ai.workspacesHelp')}</span>
          </span>
          <select
            className="input w-72 max-w-full"
            disabled={locked('workspaceAi')}
            value={entry('workspaceAi').value as WorkspaceAiPolicy}
            onChange={(e) => save({ workspaceAi: e.target.value })}
          >
            {WORKSPACE_AI_POLICIES.map((p) => (
              <option key={p} value={p}>
                {t(`admin.ai.policy.${p}`)}
              </option>
            ))}
          </select>
        </label>
      </Card>
    </>
  );
}
