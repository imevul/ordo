import {
  defaultGitAutomation,
  ESTIMATE_SCALE_NAMES,
  GIT_EVENT_LABELS,
  GIT_EVENTS,
  type GitAutomation,
  LABEL_COLORS,
  MEMBER_ROLE_LABELS,
  STATE_TYPE_LABELS,
  STATE_TYPES,
  type StateType,
  type Team,
  type TeamRole,
  type WorkflowState,
} from '@ordo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { StatusIcon, TeamIcon } from '../../components/icons.tsx';
import { Picker } from '../../components/properties.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { ConfirmModal, confirmDialog } from '../../components/ui/Modal.tsx';
import { Popover } from '../../components/ui/Popover.tsx';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './index.tsx';

export function TeamsSection() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<Team>(wsPath(ws.slug, '/teams'), body),
    { success: 'Team created' },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name,
        key,
        private: isPrivate,
        color: LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)],
      },
      {
        onSuccess: (t) =>
          navigate({ to: '/$slug/settings/team/$key', params: { slug: ws.slug, key: t.key } }),
      },
    );
  };
  return (
    <>
      <SettingsCard
        title="Teams"
        description="Every team has its own workflow, issue identifiers, cycles and settings."
      >
        {ws.teams.map((t) => (
          <Link
            key={t.id}
            to="/$slug/settings/team/$key"
            params={{ slug: ws.slug, key: t.key }}
            className="row flex h-11 items-center gap-3 border-b border-border-soft px-1"
          >
            <TeamIcon color={t.color} label={t.key} />
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            {t.private && (
              <span className="tag">
                <Lock size={11} /> private
              </span>
            )}
            <span className="tag font-mono">{t.key}</span>
            <span className="font-mono text-[11px] text-index">{t.memberIds.length} members</span>
          </Link>
        ))}
      </SettingsCard>
      {!ws.isGuest && (
        <SettingsCard title="New team">
          <form onSubmit={submit} className="grid grid-cols-[1fr_7rem_auto] gap-2">
            <input
              className="input"
              placeholder="Team name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setKey(
                  e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 3),
                );
              }}
              required
            />
            <input
              className="input font-mono"
              placeholder="KEY"
              value={key}
              maxLength={7}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              required
            />
            <button className="btn btn-primary">
              <Plus size={13} /> Create
            </button>
            <label className="col-span-3 flex items-center gap-2 text-[13px] text-muted">
              <input
                type="checkbox"
                className="accent-[#ff1493]"
                checked={isPrivate}
                onChange={(e) => setPrivate(e.target.checked)}
              />
              Private — only members and workspace admins can see it
            </label>
          </form>
        </SettingsCard>
      )}
    </>
  );
}

function StateRow({ state, team }: { state: WorkflowState; team: Team }) {
  const ws = useWorkspace();
  const [name, setName] = useState(state.name);
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/states/${state.id}`), body),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/states/${state.id}`)));
  const setDefault = useWsMutation(ws.slug, () =>
    api.patch(wsPath(ws.slug, `/teams/${team.id}`), { defaultStateId: state.id }),
  );
  const isDefault = team.defaultStateId === state.id;
  return (
    <div className="group flex h-10 items-center gap-3 border-b border-border-soft/60 pl-2">
      <Popover
        width={176}
        trigger={
          <button type="button" aria-label="Status color">
            <StatusIcon type={state.type} color={state.color} />
          </button>
        }
      >
        {(close) => (
          <div className="grid grid-cols-6 gap-1.5 p-2.5">
            {LABEL_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className="h-5 w-5"
                style={{ background: c }}
                onClick={() => {
                  save.mutate({ color: c });
                  close();
                }}
                aria-label={c}
              />
            ))}
          </div>
        )}
      </Popover>
      <input
        className="h-8 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none focus:shadow-[inset_0_-1px_0_var(--color-primary)]"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== state.name && save.mutate({ name })}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        aria-label="Status name"
      />
      {isDefault ? (
        <span className="chip [--chip:var(--color-primary)]">default</span>
      ) : (
        state.type !== 'completed' &&
        state.type !== 'canceled' && (
          <button
            type="button"
            className="font-mono text-[10.5px] tracking-[0.1em] text-index uppercase opacity-0 group-hover:opacity-100 hover:text-text"
            onClick={() => setDefault.mutate(undefined)}
          >
            make default
          </button>
        )
      )}
      <button
        type="button"
        className="btn btn-danger btn-sm opacity-0 group-hover:opacity-100"
        onClick={async () => {
          const ok = await confirmDialog({
            title: `Delete status “${state.name}”?`,
            body: 'Its issues move to another status of the same type.',
            danger: true,
          });
          if (ok) remove.mutate(undefined);
        }}
        aria-label={`Delete ${state.name}`}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function AddState({ team, type }: { team: Team; type: StateType }) {
  const ws = useWorkspace();
  const [name, setName] = useState('');
  const add = useWsMutation(ws.slug, (body: object) =>
    api.post(wsPath(ws.slug, `/teams/${team.id}/states`), body),
  );
  return (
    <form
      className="flex h-9 items-center gap-2 pl-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        add.mutate(
          { name, type, color: team.states.find((s) => s.type === type)?.color ?? '#b8aab2' },
          { onSuccess: () => setName('') },
        );
      }}
    >
      <Plus size={13} className="text-index" />
      <input
        className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-index"
        placeholder={`Add ${STATE_TYPE_LABELS[type].toLowerCase()} status…`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
    </form>
  );
}

export function TeamSettings({ team }: { team: Team }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState(team.name);
  const [key, setKey] = useState(team.key);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useWsMutation(
    ws.slug,
    (body: object) => api.patch(wsPath(ws.slug, `/teams/${team.id}`), body),
    { success: 'Team saved' },
  );
  const join = useWsMutation(ws.slug, (on: boolean) =>
    on
      ? api.post(wsPath(ws.slug, `/teams/${team.id}/members`), {})
      : api.del(wsPath(ws.slug, `/teams/${team.id}/members/${ws.me.id}`)),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/teams/${team.id}`)), {
    success: 'Team deleted',
  });
  const member = team.memberIds.includes(ws.me.id);
  const canAdmin = ws.canAdminTeam(team.id);

  return (
    <>
      {!canAdmin && (
        <p className="mb-6 border border-border-soft px-3 py-2 text-[13px] text-muted">
          Only team admins and workspace admins can change this team's settings.
        </p>
      )}
      {/* A disabled fieldset makes every control below read-only for non-admins. */}
      <fieldset disabled={!canAdmin} className="contents">
        <SettingsCard title="General">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(
                { name, key },
                {
                  onSuccess: () => {
                    if (key !== team.key)
                      navigate({ to: '/$slug/settings/team/$key', params: { slug: ws.slug, key } });
                  },
                },
              );
            }}
          >
            <div className="grid grid-cols-[1fr_8rem] gap-3">
              <FormRow label="Name">
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </FormRow>
              <FormRow label="Key" hint="Renames every identifier.">
                <input
                  className="input font-mono"
                  value={key}
                  maxLength={7}
                  onChange={(e) => setKey(e.target.value.toUpperCase())}
                  required
                />
              </FormRow>
            </div>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {LABEL_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => save.mutate({ color: c })}
                  className={`h-5 w-5 ${team.color === c ? 'outline-2 outline-offset-2 outline-text' : ''}`}
                  style={{ background: c }}
                  aria-label={`Team color ${c}`}
                />
              ))}
            </div>
            <button className="btn btn-primary">Save</button>
          </form>
        </SettingsCard>

        <SettingsCard title="Features">
          <label className="flex items-center justify-between border-b border-border-soft py-3 text-[13.5px]">
            <span>
              Private team
              <span className="block text-[12px] text-index">
                Only members of this team and workspace admins can see it and its issues.
              </span>
            </span>
            <input
              type="checkbox"
              className="accent-[#ff1493]"
              checked={team.private}
              onChange={(e) => save.mutate({ private: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between border-b border-border-soft py-3 text-[13.5px]">
            <span>
              Triage
              <span className="block text-[12px] text-index">
                An inbox for incoming issues that need review before they enter the backlog.
              </span>
            </span>
            <input
              type="checkbox"
              className="accent-[#ff1493]"
              checked={team.triageEnabled}
              onChange={(e) => save.mutate({ triageEnabled: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between border-b border-border-soft py-3 text-[13.5px]">
            <span>
              Cycles
              <span className="block text-[12px] text-index">
                Time-boxed iterations for planning work.
              </span>
            </span>
            <input
              type="checkbox"
              className="accent-[#ff1493]"
              checked={team.cyclesEnabled}
              onChange={(e) => save.mutate({ cyclesEnabled: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between py-3 text-[13.5px]">
            <span>
              Estimates
              <span className="block text-[12px] text-index">Scale used for issue estimates.</span>
            </span>
            <select
              className="input w-40"
              value={team.estimateScale}
              onChange={(e) => save.mutate({ estimateScale: e.target.value })}
            >
              {ESTIMATE_SCALE_NAMES.map((s) => (
                <option key={s} value={s}>
                  {s === 'tshirt' ? 'T-shirt sizes' : s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </SettingsCard>

        <SettingsCard
          title="Workflow"
          description="Statuses are grouped by type. Issues move through them from left to right on the board."
        >
          {STATE_TYPES.filter((t) => t !== 'triage' || team.triageEnabled).map((type) => (
            <div key={type} className="mb-4">
              <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
                {STATE_TYPE_LABELS[type]}
              </div>
              {team.states
                .filter((s) => s.type === type)
                .map((s) => (
                  <StateRow key={s.id} state={s} team={team} />
                ))}
              <AddState team={team} type={type} />
            </div>
          ))}
        </SettingsCard>

        <GitAutomationCard team={team} onSave={(gitAutomation) => save.mutate({ gitAutomation })} />
      </fieldset>

      {(member || !ws.isGuest) && (
        <div className="mb-10">
          <button type="button" className="btn btn-ghost" onClick={() => join.mutate(!member)}>
            {member ? 'Leave team' : 'Join team'}
          </button>
        </div>
      )}
      <TeamMembers team={team} />

      {ws.isAdmin && (
        <SettingsCard title="Danger zone">
          <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> Delete team
          </button>
        </SettingsCard>
      )}
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${team.name}?`}
        body="This permanently deletes the team and all of its issues, cycles and statuses."
        confirmLabel="Delete team"
        danger
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () =>
              navigate({
                to: '/$slug/settings/$section',
                params: { slug: ws.slug, section: 'teams' },
              }),
            onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
          })
        }
      />
    </>
  );
}

/** Team membership. Team admins (and workspace admins) add people, change roles and remove them. */
function TeamMembers({ team }: { team: Team }) {
  const ws = useWorkspace();
  const canAdmin = ws.canAdminTeam(team.id);
  const add = useWsMutation(ws.slug, (userId: string) =>
    api.post(wsPath(ws.slug, `/teams/${team.id}/members`), { userId }),
  );
  const setRole = useWsMutation(ws.slug, (v: { userId: string; role: TeamRole }) =>
    api.patch(wsPath(ws.slug, `/teams/${team.id}/members/${v.userId}`), { role: v.role }),
  );
  const remove = useWsMutation(ws.slug, (userId: string) =>
    api.del(wsPath(ws.slug, `/teams/${team.id}/members/${userId}`)),
  );
  const candidates = ws.members.filter((m) => !team.memberIds.includes(m.id));
  return (
    <SettingsCard
      title={`Members · ${team.members.length}`}
      description={
        team.private
          ? 'This team is private: only its members and workspace admins can see it.'
          : 'Everyone except guests can see this team. Guests see it only once added here.'
      }
    >
      {canAdmin && candidates.length > 0 && (
        <div className="mb-3">
          <Picker
            placeholder="Add someone…"
            options={candidates.map((m) => ({
              value: m.id,
              label: m.name,
              hint: MEMBER_ROLE_LABELS[m.role],
              keywords: `${m.username} ${m.email}`,
              icon: <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={16} />,
            }))}
            selected={[]}
            onSelect={(id) => add.mutate(id)}
            trigger={
              <button type="button" className="btn btn-ghost btn-sm">
                <Plus size={12} /> Add member
              </button>
            }
          />
        </div>
      )}
      {team.members.map(({ userId, role }) => {
        const m = ws.memberById.get(userId);
        if (!m) return null;
        return (
          <div key={userId} className="flex h-11 items-center gap-3 border-b border-border-soft">
            <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={20} />
            <span className="min-w-0 flex-1 truncate text-[13.5px]">
              {m.name}
              {m.role === 'guest' && <span className="ml-2 tag font-mono">guest</span>}
            </span>
            {canAdmin ? (
              <select
                className="h-7 border border-border bg-bg px-2 text-[12px] outline-none focus:border-primary"
                value={role}
                onChange={(e) => setRole.mutate({ userId, role: e.target.value as TeamRole })}
                aria-label={`Team role of ${m.name}`}
              >
                <option value="member">Member</option>
                <option value="admin">Team admin</option>
              </select>
            ) : (
              <span className="tag font-mono">{role === 'admin' ? 'team admin' : 'member'}</span>
            )}
            {(canAdmin || userId === ws.me.id) && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => remove.mutate(userId)}
                aria-label={userId === ws.me.id ? 'Leave team' : `Remove ${m.name}`}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        );
      })}
      {team.members.length === 0 && (
        <p className="font-mono text-[12px] text-index">// nobody has joined yet</p>
      )}
    </SettingsCard>
  );
}

/** Where linked branches and pull requests move this team's issues. */
function GitAutomationCard({
  team,
  onSave,
}: {
  team: Team;
  onSave: (automation: GitAutomation) => void;
}) {
  const defaults = defaultGitAutomation(team.states);
  const name = (id: string | null) => team.states.find((s) => s.id === id)?.name ?? 'no change';
  return (
    <SettingsCard
      title="Git automation"
      description="Issues named in a branch, pull request title, or after “fixes” in a description or commit move through these statuses. They only ever move forward."
    >
      {GIT_EVENTS.map((event) => (
        <label
          key={event}
          className="flex items-center justify-between border-b border-border-soft py-2.5 text-[13.5px]"
        >
          {GIT_EVENT_LABELS[event]}
          <select
            className="input w-52"
            value={team.gitAutomation[event] ?? ''}
            onChange={(e) => {
              const next: GitAutomation = { ...team.gitAutomation };
              if (e.target.value) next[event] = e.target.value;
              else delete next[event];
              onSave(next);
            }}
          >
            <option value="">Default ({name(defaults[event])})</option>
            <option value="none">No change</option>
            {team.states.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ))}
    </SettingsCard>
  );
}
