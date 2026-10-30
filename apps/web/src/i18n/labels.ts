import type {
  EstimateScale,
  InitiativeStatus,
  ProjectHealth,
  ProjectStatus,
  StateType,
} from '@ordo/shared';
import { t } from './index.ts';

/**
 * Translated labels for the fixed values in @ordo/shared. Use these in the web app instead of
 * PRIORITIES / priorityLabel… there, which stay English for the API and CLI.
 */

export const priorityLabel = (p: number) =>
  t(`enums.priority.${(p >= 0 && p <= 4 ? p : 0) as 0 | 1 | 2 | 3 | 4}`);

/** Priorities in picker order, with translated labels. */
export const priorityOptions = () =>
  ([0, 1, 2, 3, 4] as const).map((value) => ({ value, label: priorityLabel(value) }));

export const stateTypeLabel = (type: StateType) => t(`enums.stateType.${type}`);
export const projectStatusLabel = (s: ProjectStatus) => t(`enums.projectStatus.${s}`);
export const initiativeStatusLabel = (s: InitiativeStatus) => t(`enums.initiativeStatus.${s}`);
export const healthLabel = (h: ProjectHealth) => t(`enums.health.${h}`);
export const roleLabel = (r: 'owner' | 'admin' | 'member' | 'guest') => t(`enums.role.${r}`);

const TSHIRT: Record<number, string> = { 1: 'XS', 2: 'S', 3: 'M', 5: 'L', 8: 'XL' };

export function estimateLabel(scale: EstimateScale, value: number | null | undefined) {
  if (value == null) return t('enums.noEstimate');
  if (scale === 'tshirt') return TSHIRT[value] ?? `${value}`;
  return t('enums.points', { count: value });
}
