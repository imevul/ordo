import {
  type CycleAutomation,
  defaultGitAutomation,
  GIT_EVENTS,
  type GitAutomation,
  type SlaHours,
  type Team,
} from '@ordo/shared';
import { useState } from 'react';
import { PriorityIcon } from '../../../components/icons.tsx';
import { t } from '../../../i18n/index.ts';
import { priorityLabel } from '../../../i18n/labels.ts';
import { SettingsCard } from '../ui.tsx';

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
export function SlaCard({ team, onSave }: { team: Team; onSave: (slaHours: SlaHours) => void }) {
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
export function CycleAutomationCard({
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
export function GitAutomationCard({
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
