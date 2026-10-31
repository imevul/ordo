import {
  type CustomField,
  type CustomFieldValue,
  fieldsForTeam,
  type GroupBy,
  groupByField,
} from '@ordo/shared';
import { getLocale, INTL_TAG, t } from '../i18n/index.ts';
import { shortDate } from './format.ts';
import type { WorkspaceData } from './workspace.tsx';

/** Fields with a fixed set of values, which issues can be grouped and filtered by. */
export const hasChoices = (f: Pick<CustomField, 'type'>) =>
  f.type === 'select' || f.type === 'multi_select' || f.type === 'person';

/**
 * The fields a screen offers: a team's (the workspace's and its own), or across teams every field
 * the reader can see, workspace fields first.
 */
export const fieldsInScope = (fields: readonly CustomField[], teamId?: string): CustomField[] =>
  teamId
    ? fieldsForTeam(fields, teamId)
    : [...fields].sort(
        (a, b) =>
          Number(!!a.teamId) - Number(!!b.teamId) ||
          a.position - b.position ||
          a.name.localeCompare(b.name),
      );

/** The custom field a grouping is by, if it exists and can be grouped by. */
export function groupingField(ws: WorkspaceData, by: GroupBy): CustomField | null {
  const id = groupByField(by);
  const field = id ? ws.customFieldById.get(id) : undefined;
  return field && hasChoices(field) ? field : null;
}

/** "Severity" for a workspace field, "Severity · ENG" for a team's when across teams. */
export function fieldLabel(ws: WorkspaceData, field: CustomField, teamId?: string) {
  const team = field.teamId && !teamId ? ws.teamById.get(field.teamId) : null;
  return team ? `${field.name} · ${team.key}` : field.name;
}

export const optionName = (field: CustomField | undefined, id: string) =>
  field?.options.find((o) => o.id === id)?.name ?? t('customFields.props.removedOption');

/** A value written out for reading: option names, a formatted number or date, a person's name. */
export function valueText(
  ws: WorkspaceData,
  field: CustomField,
  value: CustomFieldValue | null | undefined,
): string {
  if (value == null || value === '') return '';
  switch (field.type) {
    case 'select':
      return optionName(field, String(value));
    case 'multi_select':
      return (Array.isArray(value) ? value : [String(value)])
        .map((id) => optionName(field, id))
        .join(', ');
    case 'number':
      return typeof value === 'number'
        ? new Intl.NumberFormat(INTL_TAG[getLocale()]).format(value)
        : String(value);
    case 'date':
      return shortDate(String(value));
    case 'person':
      return ws.memberById.get(String(value))?.name ?? t('customFields.props.someone');
    default:
      return String(value);
  }
}
