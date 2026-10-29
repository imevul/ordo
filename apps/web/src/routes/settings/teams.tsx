import {
  type CycleAutomation,
  defaultGitAutomation,
  ESTIMATE_SCALE_NAMES,
  GIT_EVENTS,
  type GitAutomation,
  LABEL_COLORS,
  type SlaHours,
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
import { PriorityIcon, StatusIcon, TeamIcon } from '../../components/icons.tsx';
import { Picker } from '../../components/properties.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { ConfirmModal, confirmDialog } from '../../components/ui/Modal.tsx';
import { Popover } from '../../components/ui/Popover.tsx';
import { t } from '../../i18n/index.ts';
import { priorityLabel, roleLabel, stateTypeLabel } from '../../i18n/labels.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { TriageRulesCard } from './triage-rules.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

export function TeamsSection() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<Team>(wsPath(ws.slug, '/teams'), body),
    { success: t('teams.create.created') },
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
        onSuccess: (team) =>
          navigate({ to: '/$slug/settings/team/$key', params: { slug: ws.slug, key: team.key } }),
      },
    );
  };
  return (
    <>
      <SettingsCard title={t('teams.list.title')} description={t('teams.list.description')}>
        {ws.teams.map((team) => (
          <Link
            key={team.id}
            to="/$slug/settings/team/$key"
            params={{ slug: ws.slug, key: team.key }}
            className="row flex h-11 items-center gap-3 border-b border-border-soft px-1"
          >
            <TeamIcon color={team.color} label={team.key} />
            <span className="min-w-0 flex-1 truncate">{team.name}</span>
            {team.private && (
              <span className="tag">
                <Lock size={11} /> {t('teams.list.private')}
              </span>
            )}
            <span className="tag font-mono">{team.key}</span>
            <span className="font-mono text-[11px] whitespace-nowrap text-index">
              {t('teams.list.memberCount', { count: team.memberIds.length })}
            </span>
          </Link>
        ))}
      </SettingsCard>
      {!ws.isGuest && (
        <SettingsCard title={t('teams.create.title')}>
          <form onSubmit={submit} className="grid grid-cols-[1fr_7rem_auto] gap-2">
            <input
              className="input"
              placeholder={t('teams.create.namePlaceholder')}
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
              placeholder={t('teams.create.keyPlaceholder')}
              value={key}
              maxLength={7}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              required
            />
            <button className="btn btn-primary">
              <Plus size={13} /> {t('common.create')}
            </button>
            <label className="col-span-3 flex items-center gap-2 text-[13px] text-muted">
              <input
                type="checkbox"
                className="accent-primary"
                checked={isPrivate}
                onChange={(e) => setPrivate(e.target.checked)}
              />
              {t('teams.create.private')}
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
          <button type="button" aria-label={t('teams.states.color')}>
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
        aria-label={t('teams.states.name')}
      />
      {isDefault ? (
        <span className="chip [--chip:var(--color-primary)]">{t('teams.states.default')}</span>
      ) : (
        state.type !== 'completed' &&
        state.type !== 'canceled' && (
          <button
            type="button"
            className="font-mono text-[10.5px] tracking-[0.1em] text-index uppercase opacity-0 group-hover:opacity-100 hover:text-text"
            onClick={() => setDefault.mutate(undefined)}
          >
            {t('teams.states.makeDefault')}
          </button>
        )
      )}
      <button
        type="button"
        className="btn btn-danger btn-sm opacity-0 group-hover:opacity-100"
        onClick={async () => {
          const ok = await confirmDialog({
            title: t('teams.states.deleteTitle', { name: state.name }),
            body: t('teams.states.deleteBody'),
            danger: true,
          });
          if (ok) remove.mutate(undefined);
        }}
        aria-label={t('teams.states.deleteLabel', { name: state.name })}
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
        placeholder={t(`teams.states.add.${type}`)}
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
    { success: t('teams.settings.saved') },
  );
  const join = useWsMutation(ws.slug, (on: boolean) =>
    on
      ? api.post(wsPath(ws.slug, `/teams/${team.id}/members`), {})
      : api.del(wsPath(ws.slug, `/teams/${team.id}/members/${ws.me.id}`)),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/teams/${team.id}`)), {
    success: t('teams.settings.deleted'),
  });
  const member = team.memberIds.includes(ws.me.id);
  const canAdmin = ws.canAdminTeam(team.id);

  return (
    <>
      {!canAdmin && (
        <p className="mb-6 border border-border-soft px-3 py-2 text-[13px] text-muted">
          {t('teams.settings.adminsOnly')}
        </p>
      )}
      {/* A disabled fieldset makes every control below read-only for non-admins. */}
      <fieldset disabled={!canAdmin} className="contents">
        <SettingsCard title={t('teams.settings.general')}>
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
              <FormRow label={t('teams.settings.name')}>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </FormRow>
              <FormRow label={t('teams.settings.key')} hint={t('teams.settings.keyHint')}>
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
                  aria-label={t('teams.settings.teamColor', { color: c })}
                />
              ))}
            </div>
            <button className="btn btn-primary">{t('common.save')}</button>
          </form>
        </SettingsCard>

        <SettingsCard title={t('teams.settings.features')}>
          <label className="flex items-center justify-between gap-3 border-b border-border-soft py-3 text-[13.5px]">
            <span>
              {t('teams.settings.private')}
              <span className="block text-[12px] text-index">
                {t('teams.settings.privateHint')}
              </span>
            </span>
            <input
              type="checkbox"
              className="accent-primary"
              checked={team.private}
              onChange={(e) => save.mutate({ private: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 border-b border-border-soft py-3 text-[13.5px]">
            <span>
              {t('teams.settings.triage')}
              <span className="block text-[12px] text-index">{t('teams.settings.triageHint')}</span>
            </span>
            <input
              type="checkbox"
              className="accent-primary"
              checked={team.triageEnabled}
              onChange={(e) => save.mutate({ triageEnabled: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 border-b border-border-soft py-3 text-[13.5px]">
            <span>
              {t('teams.settings.cycles')}
              <span className="block text-[12px] text-index">{t('teams.settings.cyclesHint')}</span>
            </span>
            <input
              type="checkbox"
              className="accent-primary"
              checked={team.cyclesEnabled}
              onChange={(e) => save.mutate({ cyclesEnabled: e.target.checked })}
            />
          </label>
          {ws.repositories.length > 0 && (
            <label className="flex items-center justify-between gap-3 border-b border-border-soft py-3 text-[13.5px]">
              <span>
                {t('agents.repositories.teamDefault')}
                <span className="block text-[12px] text-index">
                  {t('agents.repositories.teamDefaultHint')}
                </span>
              </span>
              <select
                className="input h-8 w-48"
                value={team.defaultRepositoryId ?? ''}
                onChange={(e) => save.mutate({ defaultRepositoryId: e.target.value || null })}
              >
                <option value="">{t('agents.repositories.none')}</option>
                {ws.repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center justify-between gap-3 border-b border-border-soft py-3 text-[13.5px]">
            <span>
              {t('teams.settings.autoArchive')}
              <span className="block text-[12px] text-index">
                {t('teams.settings.autoArchiveHint')}
              </span>
            </span>
            <select
              className="input w-40"
              value={team.autoArchiveMonths ?? ''}
              onChange={(e) =>
                save.mutate({ autoArchiveMonths: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">{t('teams.settings.never')}</option>
              {[1, 3, 6, 9, 12].map((n) => (
                <option key={n} value={n}>
                  {t('teams.settings.afterMonths', { count: n })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 py-3 text-[13.5px]">
            <span>
              {t('teams.settings.estimates')}
              <span className="block text-[12px] text-index">
                {t('teams.settings.estimatesHint')}
              </span>
            </span>
            <select
              className="input w-40"
              value={team.estimateScale}
              onChange={(e) => save.mutate({ estimateScale: e.target.value })}
            >
              {ESTIMATE_SCALE_NAMES.map((s) => (
                <option key={s} value={s}>
                  {t(`teams.settings.scales.${s}`)}
                </option>
              ))}
            </select>
          </label>
        </SettingsCard>

        <SettingsCard
          title={t('teams.settings.workflow')}
          description={t('teams.settings.workflowDescription')}
        >
          {STATE_TYPES.filter((type) => type !== 'triage' || team.triageEnabled).map((type) => (
            <div key={type} className="mb-4">
              <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
                {stateTypeLabel(type)}
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

        <SlaCard team={team} onSave={(slaHours) => save.mutate({ slaHours })} />
        {team.triageEnabled && <TriageRulesCard team={team} />}
        {team.cyclesEnabled && (
          <CycleAutomationCard
            team={team}
            onSave={(cycleAutomation) => save.mutate({ cycleAutomation })}
          />
        )}
        <GitAutomationCard team={team} onSave={(gitAutomation) => save.mutate({ gitAutomation })} />
      </fieldset>

      {(member || !ws.isGuest) && team.managedBy.length === 0 && (
        <div className="mb-10">
          <button type="button" className="btn btn-ghost" onClick={() => join.mutate(!member)}>
            {member ? t('teams.settings.leave') : t('teams.settings.join')}
          </button>
        </div>
      )}
      <TeamMembers team={team} />

      {ws.isAdmin && (
        <SettingsCard title={t('teams.settings.dangerZone')}>
          <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> {t('teams.settings.deleteTeam')}
          </button>
        </SettingsCard>
      )}
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('teams.settings.deleteTitle', { name: team.name })}
        body={t('teams.settings.deleteBody')}
        confirmLabel={t('teams.settings.deleteTeam')}
        danger
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () =>
              navigate({
                to: '/$slug/settings/$section',
                params: { slug: ws.slug, section: 'teams' },
              }),
            onError: (e) =>
              toast.error(e instanceof Error ? e.message : t('teams.settings.failed')),
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
      {team.members.map(({ userId, role }) => {
        const m = ws.memberById.get(userId);
        if (!m) return null;
        return (
          <div key={userId} className="flex h-11 items-center gap-3 border-b border-border-soft">
            <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={20} />
            <span className="min-w-0 flex-1 truncate text-[13.5px]">
              {m.name}
              {m.role === 'guest' && (
                <span className="ml-2 tag font-mono">{t('teams.members.guest')}</span>
              )}
            </span>
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
                {role === 'admin' ? t('teams.members.teamAdminTag') : t('teams.members.memberTag')}
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

/** Weekday names in Date.getDay() order (Sunday first), which is how startDay is stored. */
const weekdays = () => [
  t('teams.cycleAutomation.weekdays.sunday'),
  t('teams.cycleAutomation.weekdays.monday'),
  t('teams.cycleAutomation.weekdays.tuesday'),
  t('teams.cycleAutomation.weekdays.wednesday'),
  t('teams.cycleAutomation.weekdays.thursday'),
  t('teams.cycleAutomation.weekdays.friday'),
  t('teams.cycleAutomation.weekdays.saturday'),
];

/** How long each priority may stay open before it misses its SLA. */
function SlaCard({ team, onSave }: { team: Team; onSave: (slaHours: SlaHours) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(['1', '2', '3', '4'].map((p) => [p, String(team.slaHours[p as '1'] ?? '')])),
  );
  const commit = () => {
    const next: SlaHours = {};
    for (const [p, v] of Object.entries(draft)) {
      const n = Number(v);
      if (v.trim() && Number.isInteger(n) && n > 0) next[p as '1'] = n;
    }
    if (JSON.stringify(next) !== JSON.stringify(team.slaHours)) onSave(next);
  };
  return (
    <SettingsCard title={t('teams.sla.title')} description={t('teams.sla.description')}>
      {(['1', '2', '3', '4'] as const).map((p) => (
        <label
          key={p}
          className="flex items-center justify-between gap-3 border-b border-border-soft py-2 text-[13.5px]"
        >
          <span className="inline-flex items-center gap-2">
            <PriorityIcon priority={Number(p)} /> {priorityLabel(Number(p))}
          </span>
          <span className="flex items-center gap-2 font-mono text-[12px] text-index">
            <input
              type="number"
              min={1}
              className="input h-8 w-24 text-right font-mono"
              placeholder={t('teams.sla.none')}
              value={draft[p]}
              onChange={(e) => setDraft({ ...draft, [p]: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            {t('teams.sla.hours')}
          </span>
        </label>
      ))}
    </SettingsCard>
  );
}

/** Cycles that plan themselves and carry unfinished work over. */
function CycleAutomationCard({
  team,
  onSave,
}: {
  team: Team;
  onSave: (automation: Partial<CycleAutomation>) => void;
}) {
  const auto = team.cycleAutomation;
  const row =
    'flex items-center justify-between gap-3 border-b border-border-soft py-2.5 text-[13.5px]';
  const numberSelect = (
    key: 'weeks' | 'cooldownWeeks' | 'upcoming',
    values: number[],
    label: (n: number) => string,
  ) => (
    <select
      className="input w-40"
      value={auto[key]}
      onChange={(e) => onSave({ [key]: Number(e.target.value) })}
    >
      {values.map((n) => (
        <option key={n} value={n}>
          {label(n)}
        </option>
      ))}
    </select>
  );
  return (
    <SettingsCard
      title={t('teams.cycleAutomation.title')}
      description={t('teams.cycleAutomation.description')}
    >
      <label className={row}>
        {t('teams.cycleAutomation.enabled')}
        <input
          type="checkbox"
          className="accent-primary"
          checked={auto.enabled}
          onChange={(e) => onSave({ enabled: e.target.checked })}
        />
      </label>
      {auto.enabled && (
        <>
          <label className={row}>
            {t('teams.cycleAutomation.length')}
            {numberSelect('weeks', [1, 2, 3, 4, 5, 6, 7, 8], (n) =>
              t('teams.cycleAutomation.weeks', { count: n }),
            )}
          </label>
          <label className={row}>
            {t('teams.cycleAutomation.cooldown')}
            {numberSelect('cooldownWeeks', [0, 1, 2], (n) =>
              n ? t('teams.cycleAutomation.weeks', { count: n }) : t('common.none'),
            )}
          </label>
          <label className={row}>
            {t('teams.cycleAutomation.startDay')}
            <select
              className="input w-40"
              value={auto.startDay}
              onChange={(e) => onSave({ startDay: Number(e.target.value) })}
            >
              {weekdays().map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className={row}>
            {t('teams.cycleAutomation.planAhead')}
            {numberSelect('upcoming', [1, 2, 3, 4, 5, 6], (n) =>
              t('teams.cycleAutomation.cycleCount', { count: n }),
            )}
          </label>
          <label className={row}>
            <span>
              {t('teams.cycleAutomation.rollOver')}
              <span className="block text-[12px] text-index">
                {t('teams.cycleAutomation.rollOverHint')}
              </span>
            </span>
            <input
              type="checkbox"
              className="accent-primary"
              checked={auto.rollOver}
              onChange={(e) => onSave({ rollOver: e.target.checked })}
            />
          </label>
          <label className={row}>
            <span>
              {t('teams.cycleAutomation.addStarted')}
              <span className="block text-[12px] text-index">
                {t('teams.cycleAutomation.addStartedHint')}
              </span>
            </span>
            <input
              type="checkbox"
              className="accent-primary"
              checked={auto.addStarted}
              onChange={(e) => onSave({ addStarted: e.target.checked })}
            />
          </label>
        </>
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
  const name = (id: string | null) =>
    team.states.find((s) => s.id === id)?.name ?? t('teams.git.noChangeLower');
  return (
    <SettingsCard title={t('teams.git.title')} description={t('teams.git.description')}>
      {GIT_EVENTS.map((event) => (
        <label
          key={event}
          className="flex items-center justify-between gap-3 border-b border-border-soft py-2.5 text-[13.5px]"
        >
          {t(`teams.git.events.${event}`)}
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
            <option value="">{t('teams.git.default', { status: name(defaults[event]) })}</option>
            <option value="none">{t('teams.git.noChange')}</option>
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
