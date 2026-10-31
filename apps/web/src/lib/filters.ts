import {
  canonicalTimeZone,
  DATE_FILTER_FIELDS,
  type DateFilter,
  type DateFilterField,
  type EstimateFilter,
  filterValues,
  type IssueConditions,
  type IssueFilter,
} from '@ordo/shared';

/**
 * Editing filters in the filter bar: conditions at the top level must all hold, the ones in
 * `exclude` must not ("is not"), and one `or` group must match. Pure, so it can be unit tested.
 */

export const LIST_KEYS = [
  'stateIds',
  'stateTypes',
  'priorities',
  'assigneeIds',
  'creatorIds',
  'labelIds',
  'projectIds',
  'milestoneIds',
  'cycleIds',
] as const;
export type ListKey = (typeof LIST_KEYS)[number];

export const FLAG_KEYS = [
  'blocked',
  'blocking',
  'hasPullRequest',
  'hasSubIssues',
  'isSubIssue',
] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

/** A custom field's condition, kept in `customFields` under the field's id. */
export type FieldKey = `field:${string}`;

export type ConditionKey = ListKey | DateFilterField | 'estimate' | FlagKey | FieldKey;
export const CONDITION_KEYS: ConditionKey[] = [
  ...LIST_KEYS,
  ...DATE_FILTER_FIELDS,
  'estimate',
  ...FLAG_KEYS,
];

export const isListKey = (k: ConditionKey): k is ListKey =>
  (LIST_KEYS as readonly string[]).includes(k);
export const isFlagKey = (k: ConditionKey): k is FlagKey =>
  (FLAG_KEYS as readonly string[]).includes(k);
export const isDateKey = (k: ConditionKey): k is DateFilterField =>
  (DATE_FILTER_FIELDS as readonly string[]).includes(k);
export const isFieldKey = (k: ConditionKey): k is FieldKey => k.startsWith('field:');
export const fieldKey = (fieldId: string): FieldKey => `field:${fieldId}`;
export const fieldIdOf = (k: FieldKey) => k.slice('field:'.length);

type Value = string[] | number[] | DateFilter | EstimateFilter | boolean;

/** The value of `key` in `c`, custom fields included. */
export function conditionValue(c: IssueConditions | undefined, key: ConditionKey) {
  if (!c) return undefined;
  return (isFieldKey(key) ? c.customFields?.[fieldIdOf(key)] : c[key]) as Value | undefined;
}

const isSet = (v: Value | undefined) => (Array.isArray(v) ? v.length > 0 : v !== undefined);

/** The conditions set in `c`, in the bar's order, custom fields last. Empty lists don't count. */
export function activeKeys(c: IssueConditions | undefined): ConditionKey[] {
  if (!c) return [];
  return [
    ...CONDITION_KEYS.filter((k) => isSet(conditionValue(c, k))),
    ...Object.entries(c.customFields ?? {})
      .filter(([, v]) => v.length > 0)
      .map(([id]) => fieldKey(id)),
  ];
}

/** `c` with `key` set to `value`, or removed when `value` is undefined or an empty list. */
export function setCondition(
  c: IssueConditions,
  key: ConditionKey,
  value: Value | undefined,
): IssueConditions {
  if (isFieldKey(key)) {
    const { customFields: _, ...rest } = c;
    const fields = { ...c.customFields };
    if (isSet(value)) fields[fieldIdOf(key)] = value as string[];
    else delete fields[fieldIdOf(key)];
    return Object.keys(fields).length ? { ...rest, customFields: fields } : rest;
  }
  const next = { ...c } as Record<string, unknown>;
  if (!isSet(value)) delete next[key];
  else next[key] = value;
  return next as IssueConditions;
}

/** `c` with `key` set in its "is not" part; drops `exclude` when it empties. */
export function setExcluded(
  c: IssueConditions,
  key: ConditionKey,
  value: Value | undefined,
): IssueConditions {
  const { exclude: _, ...rest } = c;
  const exclude = setCondition(c.exclude ?? {}, key, value);
  return hasConditions(exclude) ? { ...rest, exclude } : rest;
}

/**
 * Whether "is" and "is not" can switch: lists merge into the other side, but a date, estimate or
 * flag already set on the other side would be lost.
 */
export function canToggleNegation(c: IssueConditions, key: ConditionKey, negated: boolean) {
  if (isFlagKey(key) && !negated) return true;
  if (isListKey(key) || isFieldKey(key)) return true;
  return !isSet(conditionValue(negated ? c : c.exclude, key));
}

/**
 * Turns "is" into "is not" and back. Flags at the top level flip their value instead. A list
 * joins the values already on the other side.
 */
export function toggleNegation(
  c: IssueConditions,
  key: ConditionKey,
  negated: boolean,
): IssueConditions {
  if (isFlagKey(key) && !negated) return setCondition(c, key, !c[key]);
  if (!canToggleNegation(c, key, negated)) return c;
  const moving = conditionValue(negated ? c.exclude : c, key);
  const there = conditionValue(negated ? c : c.exclude, key);
  const value =
    Array.isArray(moving) && Array.isArray(there)
      ? ([...new Set([...there, ...moving] as (string | number)[])] as Value)
      : moving;
  if (negated) return setCondition(setExcluded(c, key, undefined), key, value);
  return setExcluded(setCondition(c, key, undefined), key, value);
}

export function hasConditions(c: IssueConditions | undefined): boolean {
  if (!c) return false;
  return activeKeys(c).length > 0 || hasConditions(c.exclude) || !!c.or?.some(hasConditions);
}

/** `f` with `or` group `index` replaced (or appended past the end); empty groups are dropped. */
export function setGroup<F extends IssueConditions>(
  f: F,
  index: number,
  group: IssueConditions,
): F {
  const groups = [...(f.or ?? [])];
  if (hasConditions(group)) groups[Math.min(index, groups.length)] = group;
  else groups.splice(index, 1);
  const { or: _, ...rest } = f;
  return (groups.length ? { ...rest, or: groups } : rest) as F;
}

const RELATIVE = (d: DateFilter) => !!d.range && d.range !== 'none' && d.range !== 'any';

/**
 * Adds the viewer's zone and week start when the filter has relative dates, so "today" is
 * theirs on the server and in the local copy. Other filters stay as they are (and cache as such).
 */
export function withClock(
  f: IssueFilter,
  tz: string | null | undefined,
  weekStartsOn: 0 | 1 | undefined,
): IssueFilter {
  const relative = DATE_FILTER_FIELDS.some((k) => filterValues<DateFilter>(f, k).some(RELATIVE));
  if (!relative) return f;
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    ...f,
    tz: (tz && canonicalTimeZone(tz)) || canonicalTimeZone(browser) || 'UTC',
    weekStartsOn: weekStartsOn ?? 1,
  };
}
