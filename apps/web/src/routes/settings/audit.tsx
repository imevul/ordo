import { useMemo } from 'react';
import { wsPath } from '../../api/client.ts';
import { AuditLog } from '../../components/AuditLog.tsx';
import { ActorName } from '../../components/ui/ActorName.tsx';
import { t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';

/** Settings → Audit log: the workspace's log, with its members to filter by. */
export function AuditSection() {
  const ws = useWorkspace();
  const people = useMemo(
    () =>
      [...ws.memberById.values()]
        .filter((p) => !p.placeholder)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [ws.memberById],
  );
  if (!ws.isAdmin) return <p className="text-muted">{t('workspaceSettings.audit.adminsOnly')}</p>;
  const nameOf = (id: string) => ws.memberById.get(id)?.name ?? ws.teamById.get(id)?.name;
  return (
    <SettingsCard
      title={t('workspaceSettings.audit.title')}
      description={t('workspaceSettings.audit.description')}
    >
      <AuditLog
        path={wsPath(ws.slug, '/audit-log')}
        queryKey={['ws', ws.slug, 'audit']}
        people={people}
        actor={(e) => {
          const p = e.actorId ? ws.memberById.get(e.actorId) : null;
          return p
            ? {
                id: p.id,
                name: p.name,
                color: p.avatarColor,
                avatarUrl: p.avatarUrl,
                label: <ActorName person={p} />,
              }
            : null;
        }}
        target={(e) =>
          (e.targetId &&
            (e.targetType === 'user'
              ? ws.memberById.get(e.targetId)?.name
              : e.targetType === 'team'
                ? ws.teamById.get(e.targetId)?.name
                : e.targetType === 'workspace' && e.targetId === ws.workspace.id
                  ? ws.workspace.name
                  : null)) ||
          null
        }
        targetInLine={(e) => e.targetType !== 'workspace'}
        nameOf={nameOf}
      />
    </SettingsCard>
  );
}
