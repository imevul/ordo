import type { AdminAuditEntry } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client.ts';
import { AuditLog, auditSelectClass } from '../../components/AuditLog.tsx';
import { t } from '../../i18n/index.ts';

import { Card } from './ui.tsx';

/** The instance's audit log: sign-ins and instance changes, one workspace's, or everything. */
export function Audit() {
  const [where, setWhere] = useState<string>('instance');
  const { data: workspaces = [] } = useQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/admin/workspaces'),
  });
  const params = where === 'instance' ? '' : where === 'all' ? 'scope=all' : `workspaceId=${where}`;
  return (
    <Card title={t('admin.sections.audit')}>
      <AuditLog<AdminAuditEntry>
        path="/admin/audit-log"
        queryKey={['admin', 'audit']}
        actor={(e) =>
          e.actorId
            ? {
                id: e.actorId,
                name: e.actorName ?? e.actorEmail ?? t('shell.actor.someone'),
                color: e.actorAvatarColor,
                label: (
                  <span className="text-text" title={e.actorEmail ?? undefined}>
                    {e.actorName ?? e.actorEmail}
                  </span>
                ),
              }
            : null
        }
        target={(e) => e.targetName}
        targetInLine={(e) => e.targetType !== 'workspace'}
        nameOf={(id) => workspaces.find((w) => w.id === id)?.name}
        context={(e) => (where === 'all' ? e.workspaceName : null)}
        extra={{
          params,
          active: where !== 'instance',
          clear: () => setWhere('instance'),
          controls: (
            <select
              className={auditSelectClass}
              aria-label={t('admin.audit.where')}
              value={where}
              onChange={(e) => setWhere(e.target.value)}
            >
              <option value="instance">{t('admin.audit.instance')}</option>
              <option value="all">{t('admin.audit.all')}</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ),
        }}
      />
    </Card>
  );
}
