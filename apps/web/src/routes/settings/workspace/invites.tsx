import { type Invite, isGuestRole, type MemberRole } from '@ordo/shared';
import { Copy, Mail, RotateCcw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { keys, useConfig, useInvites, useWsMutation } from '../../../api/queries.ts';
import { Picker } from '../../../components/properties.tsx';
import { t } from '../../../i18n/index.ts';
import { roleLabel } from '../../../i18n/labels.ts';
import { relativeTime, shortDate } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';

export function InviteForm() {
  const ws = useWorkspace();
  const config = useConfig();
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<Exclude<MemberRole, 'owner'>>('member');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const inv = [keys.invites(ws.slug)];
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<Invite[]>(wsPath(ws.slug, '/invites'), body),
    {
      invalidate: inv,
    },
  );
  const emailEnabled = config.data?.emailEnabled;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = emails
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    create.mutate(
      { emails: list.length ? list : undefined, role, teamIds },
      {
        onSuccess: (rows) => {
          setEmails('');
          if (list.length === 0 || !emailEnabled) {
            navigator.clipboard?.writeText(rows.map((r) => r.url).join('\n'));
            toast.success(
              list.length
                ? t('workspaceSettings.invite.linksCopied', { count: rows.length })
                : t('workspaceSettings.invite.linkCopied'),
            );
          } else toast.success(t('workspaceSettings.invite.invited', { count: rows.length }));
        },
      },
    );
  };

  return (
    <SettingsCard
      title={t('workspaceSettings.invite.title')}
      description={
        emailEnabled
          ? t('workspaceSettings.invite.descriptionEmail')
          : t('workspaceSettings.invite.descriptionNoEmail')
      }
    >
      <form onSubmit={submit}>
        <textarea
          className="input"
          rows={2}
          placeholder={t('workspaceSettings.invite.emailsPlaceholder')}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="input w-32"
            value={role}
            onChange={(e) => setRole(e.target.value as Exclude<MemberRole, 'owner'>)}
            aria-label={t('workspaceSettings.invite.role')}
          >
            {(ws.isAdmin
              ? (['member', 'guest', 'admin'] as const)
              : (['member', 'guest'] as const)
            ).map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <Picker
            multi
            placeholder={t('workspaceSettings.invite.addToTeams')}
            options={ws.teams.map((team) => ({ value: team.id, label: team.name, hint: team.key }))}
            selected={teamIds}
            onSelect={(id) =>
              setTeamIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
            }
            trigger={
              <button type="button" className="prop">
                {teamIds.length
                  ? t('workspaceSettings.invite.teamCount', { count: teamIds.length })
                  : t('workspaceSettings.invite.teams')}
              </button>
            }
          />
          <button className="btn btn-primary ml-auto">
            <Mail size={13} />{' '}
            {emails.trim() && emailEnabled
              ? t('workspaceSettings.invite.send')
              : t('workspaceSettings.invite.createLink')}
          </button>
        </div>
        {isGuestRole(role) && (
          <p className="mt-2 text-[12px] text-index">{t('workspaceSettings.invite.guestHint')}</p>
        )}
      </form>
    </SettingsCard>
  );
}

export function PendingInvites() {
  const ws = useWorkspace();
  const config = useConfig();
  const { data: invites = [] } = useInvites(ws.slug, true);
  const inv = [keys.invites(ws.slug)];
  const revoke = useWsMutation(
    ws.slug,
    (id: string) => api.del(wsPath(ws.slug, `/invites/${id}`)),
    { invalidate: inv },
  );
  const resend = useWsMutation(
    ws.slug,
    (id: string) => api.post(wsPath(ws.slug, `/invites/${id}/resend`)),
    {
      invalidate: inv,
      success: t('workspaceSettings.pending.resent'),
    },
  );
  if (invites.length === 0) return null;
  return (
    <SettingsCard title={t('workspaceSettings.pending.title', { count: invites.length })}>
      {invites.map((i) => (
        <div
          key={i.id}
          className="flex h-11 items-center gap-3 border-b border-border-soft text-[13px]"
        >
          <span className="min-w-0 flex-1 truncate">
            {i.email ?? <span className="text-muted">{t('workspaceSettings.pending.anyone')}</span>}
            {i.teamIds.length > 0 && (
              <span className="ml-2 text-index">
                → {i.teamIds.map((id) => ws.teamById.get(id)?.key ?? '?').join(', ')}
              </span>
            )}
          </span>
          <span className="tag font-mono">{roleLabel(i.role)}</span>
          <span className="hidden font-mono text-[11px] text-index sm:block">
            {i.lastSentAt
              ? t('workspaceSettings.pending.sent', { time: relativeTime(i.lastSentAt) })
              : t('workspaceSettings.pending.expires', { date: shortDate(i.expiresAt) })}
          </span>
          {i.url && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(i.url!);
                toast.success(t('workspaceSettings.invite.linkCopied'));
              }}
              aria-label={t('workspaceSettings.pending.copyLink')}
            >
              <Copy size={12} />
            </button>
          )}
          {i.email && config.data?.emailEnabled && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => resend.mutate(i.id)}
              aria-label={t('workspaceSettings.pending.resend')}
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => revoke.mutate(i.id)}
            aria-label={t('workspaceSettings.pending.revoke')}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </SettingsCard>
  );
}
