import type { Team } from '@ordo/shared';
import type { ReactNode } from 'react';
import { useWorkspace } from '../../lib/workspace.tsx';

/** Building blocks shared by the settings sections (kept apart from index.tsx, which imports them all). */

type TeamSelectBase = {
  className?: string;
  'aria-label'?: string;
  disabled?: boolean;
  title?: string;
  /** What each team is called in the list; its name by default. */
  optionLabel?: (team: Team) => string;
};
type OptionalTeamSelect = TeamSelectBase & {
  /** Label of a leading "no team" option, which reads and reports as null. */
  none: string;
  value: string | null | undefined;
  onChange: (teamId: string | null) => void;
};
type RequiredTeamSelect = TeamSelectBase & {
  none?: undefined;
  value: string;
  onChange: (teamId: string) => void;
};

/** A native picker of the workspace's teams. */
export function TeamSelect(props: OptionalTeamSelect): ReactNode;
export function TeamSelect(props: RequiredTeamSelect): ReactNode;
export function TeamSelect(props: OptionalTeamSelect | RequiredTeamSelect) {
  const ws = useWorkspace();
  const { className = 'input', optionLabel = (team) => team.name } = props;
  return (
    <select
      className={className}
      aria-label={props['aria-label']}
      disabled={props.disabled}
      title={props.title}
      value={props.value ?? ''}
      onChange={(e) => {
        if (props.none === undefined) props.onChange(e.target.value);
        else props.onChange(e.target.value || null);
      }}
    >
      {props.none !== undefined && <option value="">{props.none}</option>}
      {ws.teams.map((team) => (
        <option key={team.id} value={team.id}>
          {optionLabel(team)}
        </option>
      ))}
    </select>
  );
}

export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="section-label mb-2">{title}</div>
      {description && <p className="mb-4 text-[13px] text-muted">{description}</p>}
      {children}
    </section>
  );
}

export function FormRow({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[12px] text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-index">{hint}</span>}
    </label>
  );
}
