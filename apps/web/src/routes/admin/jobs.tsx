import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../api/client.ts';
import { t } from '../../i18n/index.ts';
import { relativeTime } from '../../lib/format.ts';

import { Card, known } from './ui.tsx';

export function Jobs() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () =>
      api.get<
        {
          id: number;
          name: string;
          status: string;
          attempts: number;
          lastError: string | null;
          runAt: string;
          createdAt: string;
        }[]
      >('/admin/jobs'),
    refetchInterval: 10_000,
  });
  const reload = () => qc.invalidateQueries({ queryKey: ['admin', 'jobs'] });
  return (
    <Card title={t('admin.jobs.title')} description={t('admin.jobs.description')}>
      {data.map((j) => (
        <div key={j.id} className="border-b border-border-soft py-2.5">
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span className="font-mono">{j.name}</span>
            <span
              className={`chip ${j.status === 'dead' ? '[--chip:var(--color-error)]' : '[--chip:var(--color-warning)]'}`}
            >
              {known(j.status, ['pending', 'running', 'dead'] as const, (k) =>
                t(`admin.jobs.status.${k}`),
              )}
            </span>
            <span className="font-mono text-[11px] text-index">
              {t('admin.jobs.attempts', { count: j.attempts })} ·{' '}
              {t(j.status === 'dead' ? 'admin.jobs.lastTried' : 'admin.jobs.next', {
                time: relativeTime(j.runAt),
              })}
            </span>
            {j.status === 'dead' && (
              <span className="ml-auto flex gap-1">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => api.post(`/admin/jobs/${j.id}/retry`).then(reload)}
                >
                  <RotateCcw size={12} /> {t('admin.jobs.retry')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  aria-label={t('admin.jobs.discard')}
                  onClick={() => api.del(`/admin/jobs/${j.id}`).then(reload)}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            )}
          </div>
          {j.lastError && (
            <pre className="mt-1 max-h-24 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-error">
              {j.lastError}
            </pre>
          )}
        </div>
      ))}
      {data.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('admin.jobs.empty')}</p>
      )}
    </Card>
  );
}
