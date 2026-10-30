import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, KeyRound, Shield, Trash2, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { relativeTime, shortDate } from '../../lib/format.ts';

import { Card, errMsg, known } from './ui.tsx';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  username: string;
  kind: string;
  isInstanceAdmin: boolean;
  canCreateWorkspaces: boolean;
  disabledAt: string | null;
  emailVerifiedAt: string | null;
  twoFactor: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  workspaceCount: number;
}

export function Users({ myId }: { myId: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const { data = [] } = useQuery({
    queryKey: ['admin', 'users', q],
    queryFn: () => api.get<AdminUser[]>(`/admin/users?q=${encodeURIComponent(q)}`),
    placeholderData: (p) => p,
  });
  const reload = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast.success(done);
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <Card title={t('admin.sections.users')}>
      <input
        className="input mb-4"
        placeholder={t('admin.users.search')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="overflow-x-auto">
        {data.map((u) => (
          <div
            key={u.id}
            className={`flex min-w-[640px] items-center gap-3 border-b border-border-soft py-2.5 ${u.disabledAt ? 'opacity-60' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px]">
                {u.name}
                {u.isInstanceAdmin && (
                  <span className="chip [--chip:var(--color-primary)]">
                    {t('admin.users.admin')}
                  </span>
                )}
                {u.canCreateWorkspaces && (
                  <span className="tag font-mono">{t('admin.users.canCreate')}</span>
                )}
                {u.disabledAt && (
                  <span className="chip [--chip:var(--color-error)]">
                    {t('admin.users.disabled')}
                  </span>
                )}
                {u.kind !== 'human' && (
                  <span className="tag font-mono">
                    {known(u.kind, ['bot', 'placeholder'] as const, (k) =>
                      t(`admin.users.kind.${k}`),
                    )}
                  </span>
                )}
                {u.twoFactor && (
                  <Shield
                    size={12}
                    className="text-success"
                    aria-label={t('admin.users.twoFactorOn')}
                  />
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-index">
                {[
                  u.emailVerifiedAt ? u.email : t('admin.users.unverified', { email: u.email }),
                  t('admin.users.workspaces', { count: u.workspaceCount }),
                  t('admin.users.joined', { date: shortDate(u.createdAt) }),
                  u.lastSeenAt && t('admin.users.seen', { time: relativeTime(u.lastSeenAt) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            {u.id !== myId && u.kind === 'human' && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={t('admin.users.resetLink')}
                  aria-label={t('admin.users.resetLinkFor', { name: u.name })}
                  onClick={() =>
                    act(async () => {
                      const res = await api.post<{ url: string; emailed: boolean }>(
                        `/admin/users/${u.id}/reset-link`,
                      );
                      navigator.clipboard?.writeText(res.url);
                      toast.success(
                        res.emailed ? t('admin.users.resetEmailed') : t('admin.users.resetCopied'),
                      );
                    })
                  }
                >
                  <KeyRound size={12} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    act(() =>
                      api.patch(`/admin/users/${u.id}`, { isInstanceAdmin: !u.isInstanceAdmin }),
                    )
                  }
                >
                  {u.isInstanceAdmin ? t('admin.users.revokeAdmin') : t('admin.users.makeAdmin')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    act(() =>
                      api.patch(`/admin/users/${u.id}`, {
                        canCreateWorkspaces: !u.canCreateWorkspaces,
                      }),
                    )
                  }
                >
                  {u.canCreateWorkspaces
                    ? t('admin.users.revokeCreate')
                    : t('admin.users.grantCreate')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={u.disabledAt ? t('admin.users.enable') : t('admin.users.disable')}
                  aria-label={
                    u.disabledAt
                      ? t('admin.users.enableUser', { name: u.name })
                      : t('admin.users.disableUser', { name: u.name })
                  }
                  onClick={() =>
                    act(() => api.patch(`/admin/users/${u.id}`, { disabled: !u.disabledAt }))
                  }
                >
                  {u.disabledAt ? <UserCheck size={12} /> : <Ban size={12} />}
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  aria-label={t('admin.users.deleteUser', { name: u.name })}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: t('admin.users.deleteTitle', { email: u.email }),
                      body: t('admin.users.deleteBody'),
                      danger: true,
                    });
                    if (ok) act(() => api.del(`/admin/users/${u.id}`), t('admin.users.deleted'));
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
