import type { ProjectHealth } from '@ordo/shared';
import { t } from '../../i18n/index.ts';
import { healthLabel } from '../../i18n/labels.ts';

export const HEALTH_COLOR: Record<ProjectHealth, string> = {
  on_track: 'var(--color-success)',
  at_risk: 'var(--color-warning)',
  off_track: 'var(--color-error)',
};

export function HealthChip({ health }: { health: ProjectHealth | null }) {
  if (!health)
    return <span className="chip [--chip:var(--color-index)]">{t('projects.noUpdate')}</span>;
  return (
    <span className="chip" style={{ ['--chip' as string]: HEALTH_COLOR[health] }}>
      {healthLabel(health)}
    </span>
  );
}
