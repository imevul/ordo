import { isOwnerRole, MEMBER_ROLES } from '@ordo/shared';
import { Ban, Trash2, UserCheck } from 'lucide-react';
import { api, wsPath } from '../../../api/client.ts';
import { useWsMutation } from '../../../api/queries.ts';
import { Avatar } from '../../../components/ui/Avatar.tsx';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { roleLabel } from '../../../i18n/labels.ts';
import { relativeTime } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { InviteForm, PendingInvites } from './invites.tsx';

export function MembersSection() {
  const ws = useWorkspace();
  const isAdmin = ws.isAdmin;
  const canInvite = isAdmin || (!ws.isGuest && ws.workspace.settings.invitePolicy === 'members');
  const update = useWsMutation(
    ws.slug,
    (v: { userId: string; role?: string; suspended?: boolean }) =>
      api.patch(wsPath(ws.slug, `/members/${v.userId}`), { role: v.role, suspended: v.suspended }),
  );
  const removeMember = useWsMutation(
    ws.slug,
    (userId: string) => api.del(wsPath(ws.slug, `/members/${userId}`)),
    {
      success: t('workspaceSettings.members.removed'),
    },
  );

  // Agents are members too, but they're managed under Settings → Agents.
  const people = ws.members.filter((m) => m.kind !== 'agent');
  return (
    <>
      {canInvite && <InviteForm />}
      {canInvite && <PendingInvites />}
      <SettingsCard title={t('workspaceSettings.members.title', { count: people.length })}>
        {people.map((m) => (
          <div
            key={m.id}
            className={`flex h-12 items-center gap-3 border-b border-border-soft ${m.suspended ? 'opacity-60' : ''}`}
          >
            <Avatar
              name={m.name}
              color={m.avatarColor}
              src={m.avatarUrl}
              size={24}
              status={m.status}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">
                {m.name}{' '}
                {m.id === ws.me.id && (
                  <span className="text-index">{t('workspaceSettings.members.you')}</span>
                )}
                {m.suspended && (
                  <span className="chip ml-2 [--chip:var(--color-warning)]">
                    {t('workspaceSettings.members.suspended')}
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-index">
                @{m.username}
                {m.email && ` · ${m.email}`}
              </div>
            </div>
            <span className="hidden font-mono text-[11px] text-index md:block">
              {t('workspaceSettings.members.joined', { time: relativeTime(m.joinedAt) })}
            </span>
            {/* Admins manage roles; only owners can grant or take away ownership. */}
            {isAdmin && (ws.isOwner || !isOwnerRole(m.role)) ? (
              <select
                className="h-7 border border-border bg-bg px-2 text-[12px] outline-none focus:border-primary"
                value={m.role}
                onChange={(e) => update.mutate({ userId: m.id, role: e.target.value })}
                aria-label={t('workspaceSettings.members.roleOf', { name: m.name })}
              >
                {MEMBER_ROLES.filter((r) => ws.isOwner || !isOwnerRole(r)).map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="tag font-mono">{roleLabel(m.role)}</span>
            )}
            {isAdmin && m.id !== ws.me.id && (ws.isOwner || !isOwnerRole(m.role)) && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => update.mutate({ userId: m.id, suspended: !m.suspended })}
                aria-label={t(
                  m.suspended
                    ? 'workspaceSettings.members.restore'
                    : 'workspaceSettings.members.suspend',
                  { name: m.name },
                )}
                title={
                  m.suspended
                    ? t('workspaceSettings.members.restoreHint')
                    : t('workspaceSettings.members.suspendHint')
                }
              >
                {m.suspended ? <UserCheck size={12} /> : <Ban size={12} />}
              </button>
            )}
            {(isAdmin || m.id === ws.me.id) && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  const self = m.id === ws.me.id;
                  const ok = await confirmDialog({
                    title: self
                      ? t('workspaceSettings.members.leaveTitle')
                      : t('workspaceSettings.members.removeTitle', { name: m.name }),
                    confirmLabel: self ? t('workspaceSettings.members.leave') : t('common.remove'),
                    danger: true,
                  });
                  if (ok) removeMember.mutate(m.id);
                }}
                aria-label={
                  m.id === ws.me.id
                    ? t('workspaceSettings.members.leaveWorkspace')
                    : t('workspaceSettings.members.removeName', { name: m.name })
                }
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
      </SettingsCard>
    </>
  );
}
