import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { t } from '../../i18n/index.ts';

import { Card, errMsg } from './ui.tsx';

export function Domains() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['admin', 'domains'],
    queryFn: () =>
      api.get<
        {
          id: string;
          domain: string;
          verified: boolean;
          verifiedBy: string | null;
          workspace: string;
          workspaceSlug: string;
        }[]
      >('/admin/domains'),
  });
  return (
    <Card title={t('admin.sections.domains')} description={t('admin.domains.description')}>
      {data.map((d) => (
        <div
          key={d.id}
          className="flex items-center gap-3 border-b border-border-soft py-2.5 text-[13px]"
        >
          <span className="flex-1 font-mono">{d.domain}</span>
          <span className="text-muted">{d.workspace}</span>
          {d.verified ? (
            <span className="chip [--chip:var(--color-success)]">
              {d.verifiedBy === 'instance_admin'
                ? t('admin.domains.verifiedByAdmin')
                : t('admin.domains.verified')}
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                try {
                  await api.post(`/admin/domains/${d.id}/approve`);
                  qc.invalidateQueries({ queryKey: ['admin', 'domains'] });
                } catch (err) {
                  toast.error(errMsg(err));
                }
              }}
            >
              {t('admin.domains.approve')}
            </button>
          )}
        </div>
      ))}
      {data.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('admin.domains.empty')}</p>
      )}
    </Card>
  );
}
