import { isGuestRole, isTeamAdminRole, type Team, type TeamRole } from '@ordo/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, wsPath } from '../../../api/client.ts';
import { useWsMutation } from '../../../api/queries.ts';
import { Picker } from '../../../components/properties.tsx';
import { Avatar } from '../../../components/ui/Avatar.tsx';
import { t } from '../../../i18n/index.ts';
import { roleLabel } from '../../../i18n/labels.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';

/** A capacity per cycle, saved on blur or Enter; empty means none (null). */
export function CapacityInput({
  value,
  placeholder,
  onSave,
  label,
  className,
}: {
  value: number | null;
  placeholder?: number | null;
  onSave: (value: number | null) => void;
  label: string;
  className: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  const commit = () => {
    const next = text.trim() === '' ? null : Number(text);
    if (next != null && (!Number.isInteger(next) || next < 0)) {
      setText(value == null ? '' : String(value));
      return;
    }
    if (next !== value) onSave(next);
  };
  return (
    <input
      type="number"
      min={0}
      max={10000}
      step={1}
      className={className}
      value={text}
      placeholder={placeholder == null ? '' : String(placeholder)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      aria-label={label}
    />
  );
}

/** Team membership. Team admins (and workspace admins) add people, change roles and remove them. */
export function TeamMembers({ team }: { team: Team }) {
  const ws = useWorkspace();
  const canAdmin = ws.canAdminTeam(team.id);
  const add = useWsMutation(ws.slug, (userId: string) =>
    api.post(wsPath(ws.slug, `/teams/${team.id}/members`), { userId }),
  );
  const setRole = useWsMutation(ws.slug, (v: { userId: string; role: TeamRole }) =>
    api.patch(wsPath(ws.slug, `/teams/${team.id}/members/${v.userId}`), { role: v.role }),
  );
  const setCapacity = useWsMutation(
    ws.slug,
    (v: { userId: string; capacity: number | null }) =>
      api.patch(wsPath(ws.slug, `/teams/${team.id}/members/${v.userId}`), {
        capacity: v.capacity,
      }),
    { success: t('teams.members.capacitySaved') },
  );
  const remove = useWsMutation(ws.slug, (userId: string) =>
    api.del(wsPath(ws.slug, `/teams/${team.id}/members/${userId}`)),
  );
  const candidates = ws.members.filter((m) => !team.memberIds.includes(m.id));
  // A directory group decides who is on the team; roles are still set here.
  const managed = team.managedBy.length > 0;
  return (
    <SettingsCard
      title={t('teams.members.title', { count: team.members.length })}
      description={
        team.private ? t('teams.members.privateDescription') : t('teams.members.publicDescription')
      }
    >
      {managed && (
        <p className="mb-3 border border-border-soft px-3 py-2 text-[13px] text-muted">
          {t('teams.members.managedBy', {
            groups: team.managedBy.join(', '),
            count: team.managedBy.length,
          })}
        </p>
      )}
      {canAdmin && !managed && candidates.length > 0 && (
        <div className="mb-3">
          <Picker
            placeholder={t('teams.members.addSomeone')}
            options={candidates.map((m) => ({
              value: m.id,
              label: m.name,
              hint: roleLabel(m.role),
              keywords: `${m.username} ${m.email}`,
              icon: <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={16} />,
            }))}
            selected={[]}
            onSelect={(id) => add.mutate(id)}
            trigger={
              <button type="button" className="btn btn-ghost btn-sm">
                <Plus size={12} /> {t('teams.members.addMember')}
              </button>
            }
          />
        </div>
      )}
      {team.members.map(({ userId, role, capacity }) => {
        const m = ws.memberById.get(userId);
        if (!m) return null;
        return (
          <div key={userId} className="flex h-11 items-center gap-3 border-b border-border-soft">
            <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={20} />
            <span className="min-w-0 flex-1 truncate text-[13.5px]">
              {m.name}
              {isGuestRole(m.role) && (
                <span className="ml-2 tag font-mono">{t('teams.members.guest')}</span>
              )}
            </span>
            {canAdmin ? (
              <CapacityInput
                value={capacity}
                placeholder={team.defaultCapacity}
                onSave={(c) => setCapacity.mutate({ userId, capacity: c })}
                label={t('teams.members.capacityOf', { name: m.name })}
                className="h-7 w-20 border border-border bg-bg px-2 font-mono text-[12px] outline-none focus:border-primary"
              />
            ) : (
              capacity != null && (
                <span
                  className="font-mono text-[12px] text-muted"
                  title={t('teams.members.capacityOf', { name: m.name })}
                >
                  {capacity}
                </span>
              )
            )}
            {canAdmin ? (
              <select
                className="h-7 border border-border bg-bg px-2 text-[12px] outline-none focus:border-primary"
                value={role}
                onChange={(e) => setRole.mutate({ userId, role: e.target.value as TeamRole })}
                aria-label={t('teams.members.roleOf', { name: m.name })}
              >
                <option value="member">{t('teams.members.member')}</option>
                <option value="admin">{t('teams.members.teamAdmin')}</option>
              </select>
            ) : (
              <span className="tag font-mono">
                {isTeamAdminRole(role)
                  ? t('teams.members.teamAdminTag')
                  : t('teams.members.memberTag')}
              </span>
            )}
            {(canAdmin || userId === ws.me.id) && !managed && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => remove.mutate(userId)}
                aria-label={
                  userId === ws.me.id
                    ? t('teams.members.leave')
                    : t('teams.members.remove', { name: m.name })
                }
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        );
      })}
      {team.members.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('teams.members.empty')}</p>
      )}
    </SettingsCard>
  );
}
