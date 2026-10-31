/**
 * Custom fields: properties a workspace or team adds to its issues ("Customer tier", "Severity",
 * "Release date"…). Definitions come with the bootstrap; an issue carries its values in
 * `customFields`, keyed by field id.
 */

export const CUSTOM_FIELD_TYPES = [
  'select',
  'multi_select',
  'number',
  'date',
  'text',
  'person',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomFieldOption {
  /** Stable within the field, so renaming an option keeps the issues that have it. */
  id: string;
  name: string;
  color: string;
}

export interface CustomField {
  id: string;
  /** Null for fields every team's issues have. */
  teamId: string | null;
  name: string;
  description: string | null;
  type: CustomFieldType;
  /** The choices of select and multi-select fields; empty for the other types. */
  options: CustomFieldOption[];
  position: number;
}

/**
 * A value as the API sends it: an option id (select), option ids (multi-select), a number, a
 * `YYYY-MM-DD` date, text, or a user id (person). Issues leave out fields without a value.
 */
export type CustomFieldValue = string | number | string[];

/** The fields an issue of `teamId` has: the workspace's and its team's, in order. */
export const fieldsForTeam = <F extends Pick<CustomField, 'teamId' | 'position' | 'name'>>(
  fields: readonly F[],
  teamId: string,
): F[] =>
  fields
    .filter((f) => !f.teamId || f.teamId === teamId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

/**
 * Whether a value matches a custom field filter: one of `wanted` (option ids, user ids, `me`, or
 * the value written out), or `none` for issues without a value. Multi-selects match when any of
 * their options is wanted. The API's `filterConditions` does the same in SQL.
 */
export function matchesFieldFilter(
  value: CustomFieldValue | undefined,
  wanted: readonly string[],
  me: string,
): boolean {
  if (!wanted.length) return true;
  const values = value === undefined ? [] : Array.isArray(value) ? value : [String(value)];
  if (!values.length) return wanted.includes('none');
  const ids = wanted.map((w) => (w === 'me' ? me : w));
  return values.some((v) => ids.includes(v));
}
