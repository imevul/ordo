import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { t } from '../../i18n/index.ts';
import { shortDate } from '../../lib/format.ts';

import { Card, errMsg } from './ui.tsx';

export function Workspaces() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: () =>
      api.get<
        {
          id: string;
          name: string;
          slug: string;
          createdAt: string;
          members: number;
          issues: number;
          owners: string[];
        }[]
      >('/admin/workspaces'),
  });
  return (
    <Card title={t('admin.sections.workspaces')}>
      {data.map((w) => (
        <div key={w.id} className="flex items-center gap-3 border-b border-border-soft py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px]">
              {w.name} <span className="font-mono text-[11px] text-index">/{w.slug}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {[
                t('admin.workspaces.members', { count: w.members }),
                t('common.issueCount', { count: w.issues }),
                t('admin.workspaces.ownedBy', {
                  owners: w.owners.join(', ') || t('admin.workspaces.nobody'),
                }),
                t('admin.workspaces.created', { date: shortDate(w.createdAt) }),
              ].join(' · ')}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            aria-label={t('admin.workspaces.delete', { name: w.name })}
            onClick={async () => {
              const typed = prompt(
                t('admin.workspaces.deletePrompt', { name: w.name, slug: w.slug }),
              );
              if (typed !== w.slug) return;
              try {
                await api.del(`/admin/workspaces/${w.id}`, { confirmSlug: typed });
                qc.invalidateQueries({ queryKey: ['admin'] });
                toast.success(t('admin.workspaces.deleted'));
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </Card>
  );
}
