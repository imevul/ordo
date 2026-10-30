import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { t } from '../../i18n/index.ts';

import { Card, Stat } from './ui.tsx';

export function Overview() {
  const { data } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () =>
      api.get<{
        version: string;
        users: number;
        workspaces: number;
        issues: number;
        databaseSize: string | null;
        jobs: Record<string, number>;
        leases: { key: string; holder: string; expiresAt: string }[];
        realtimeConnections: number;
        storage: string;
        emailEnabled: boolean;
        secretKey: 'ok' | 'missing' | 'unreadable';
        unreadableSecrets: number;
      }>('/admin/overview'),
    refetchInterval: 10_000,
  });
  if (!data) return <Spinner />;
  return (
    <>
      <Card title={t('admin.overview.instance')}>
        <div className="grid grid-cols-2 gap-px bg-border-soft md:grid-cols-4">
          <Stat label={t('admin.overview.version')} value={data.version} />
          <Stat label={t('admin.overview.users')} value={data.users} />
          <Stat label={t('admin.overview.workspaces')} value={data.workspaces} />
          <Stat label={t('admin.overview.issues')} value={data.issues} />
          <Stat label={t('admin.overview.database')} value={data.databaseSize ?? '—'} />
          <Stat label={t('admin.overview.liveSockets')} value={data.realtimeConnections} />
          <Stat label={t('admin.overview.pendingJobs')} value={data.jobs.pending ?? 0} />
          <Stat
            label={t('admin.overview.deadJobs')}
            value={data.jobs.dead ?? 0}
            tone={data.jobs.dead ? 'text-error' : 'text-success'}
          />
        </div>
      </Card>
      <Card title={t('admin.overview.health')}>
        <div className="flex flex-col gap-2 font-mono text-[12.5px]">
          <span>
            <span
              className={`mr-2 inline-block h-[7px] w-[7px] ${data.emailEnabled ? 'bg-success' : 'bg-warning'}`}
            />
            {data.emailEnabled ? t('admin.overview.emailOk') : t('admin.overview.emailOff')}
          </span>
          <span>
            <span
              className={`mr-2 inline-block h-[7px] w-[7px] ${data.secretKey === 'ok' ? 'bg-success' : 'bg-error'}`}
            />
            {data.secretKey === 'ok'
              ? t('admin.overview.secretKeyOk')
              : data.secretKey === 'missing'
                ? t('admin.overview.secretKeyMissing')
                : t('admin.overview.secretKeyUnreadable', { count: data.unreadableSecrets })}
          </span>
          <span>
            <span className="mr-2 inline-block h-[7px] w-[7px] bg-success" />
            {t('admin.overview.storage', { storage: data.storage })}
          </span>
          {data.leases.map((l) => (
            <span key={l.key} className="text-muted">
              &gt; {t('admin.overview.lease', { key: l.key, holder: l.holder })}
            </span>
          ))}
        </div>
      </Card>
    </>
  );
}
