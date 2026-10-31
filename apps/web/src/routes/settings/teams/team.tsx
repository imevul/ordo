import { ESTIMATE_SCALE_NAMES, LABEL_COLORS, STATE_TYPES, type Team } from '@ordo/shared';
import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { useWsMutation } from '../../../api/queries.ts';
import { ConfirmModal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { stateTypeLabel } from '../../../i18n/labels.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { TriageRulesCard } from '../triage-rules.tsx';
import { FormRow, SettingsCard } from '../ui.tsx';
import { CycleAutomationCard, GitAutomationCard, SlaCard } from './automation.tsx';
import { TeamMembers } from './members.tsx';
import { AddState, StateRow } from './states.tsx';

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
