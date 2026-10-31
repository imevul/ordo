import {
  type Bootstrap,
  type CustomField,
  type CustomFieldOption,
  type CustomFieldValue,
  type Cycle,
  dayInZone,
  fieldsForTeam,
  isCycleCurrent,
  type Label,
  type Member,
  PRIORITIES,
  type Project,
  STATE_TYPES,
  type Team,
  type WorkflowState,
} from '@ordo/shared';

/** A name that matches nothing (or too much); the message lists what would have worked. */
export class NameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NameError';
  }
}

const norm = (s: string) => s.trim().toLowerCase();
const list = (names: string[]) => names.join(', ') || 'none';

/**
 * Turns the names people use into ids: team keys (`ENG`), status names or types, label names,
 * `me`/usernames/emails, project names, `current`/cycle numbers, custom fields and their options,
 * and priority words. Works from a
 * workspace's bootstrap, so it costs one request.
 */
export class Names {
  readonly boot: Bootstrap;
  readonly meId: string;

  constructor(boot: Bootstrap, meId: string) {
    this.boot = boot;
    this.meId = meId;
  }

  team(ref: string): Team {
    const r = norm(ref);
    const team = this.boot.teams.find(
      (t) => t.id === ref || norm(t.key) === r || norm(t.name) === r,
    );
    if (!team)
      throw new NameError(`No team "${ref}". Teams: ${list(this.boot.teams.map((t) => t.key))}`);
    return team;
  }

  /** A status by name, or the first of a type (`started`, `completed`…). */
  state(team: Team, ref: string): WorkflowState {
    const r = norm(ref);
    const byName = team.states.find((s) => s.id === ref || norm(s.name) === r);
    const byType = (STATE_TYPES as readonly string[]).includes(r)
      ? [...team.states].sort((a, b) => a.position - b.position).find((s) => s.type === r)
      : undefined;
    const state = byName ?? byType;
    if (!state)
      throw new NameError(
        `No status "${ref}" in ${team.key}. Statuses: ${list(team.states.map((s) => s.name))}`,
      );
    return state;
  }

  /** Workspace labels, plus the team's own when a team is given. */
  label(ref: string, team?: Team | null): Label {
    const r = norm(ref);
    const usable = this.boot.labels.filter((l) => !l.teamId || l.teamId === team?.id);
    const label = usable.find((l) => l.id === ref || norm(l.name) === r);
    if (!label)
      throw new NameError(`No label "${ref}". Labels: ${list(usable.map((l) => l.name))}`);
    return label;
  }

  /** `me`, a username (with or without @), an email address, a full name or an id. */
  member(ref: string): Member {
    const r = norm(ref).replace(/^@/, '');
    const id = r === 'me' ? this.meId : null;
    const matches = this.boot.members.filter(
      (m) =>
        m.id === (id ?? ref) || norm(m.username) === r || norm(m.email) === r || norm(m.name) === r,
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new NameError(
        `"${ref}" matches ${list(matches.map((m) => `@${m.username}`))}; use a username`,
      );
    throw new NameError(`No member "${ref}". Use me, a username or an email address`);
  }

  /**
   * A custom field by name or id: one of the fields `team`'s issues have, or with no team any
   * field (names are only unique within a team, so that can be ambiguous).
   */
  field(ref: string, team?: Team | null): CustomField {
    const r = norm(ref);
    const all = this.boot.customFields ?? [];
    const usable = team ? fieldsForTeam(all, team.id) : all;
    const matches = usable.filter((f) => f.id === ref || norm(f.name) === r);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new NameError(`Several teams have a field "${ref}"; give a team`);
    throw new NameError(
      `No field "${ref}"${team ? ` in ${team.key}` : ''}. Fields: ${list(usable.map((f) => f.name))}`,
    );
  }

  option(field: CustomField, ref: string): CustomFieldOption {
    const r = norm(ref);
    const option = field.options.find((o) => o.id === ref || norm(o.name) === r);
    if (!option)
      throw new NameError(
        `No option "${ref}" for ${field.name}. Options: ${list(field.options.map((o) => o.name))}`,
      );
    return option;
  }

  /**
   * A value as typed: an option name (select), option names separated by commas (multi-select), a
   * number, a `YYYY-MM-DD` date, text, or a person like `member()` takes. `none` or nothing clears
   * it (null).
   */
  fieldValue(field: CustomField, raw: string): CustomFieldValue | null {
    const value = raw.trim();
    if (!value || norm(value) === 'none') return null;
    switch (field.type) {
      case 'select':
        return this.option(field, value).id;
      case 'multi_select':
        return value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => this.option(field, v).id);
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new NameError(`${field.name} takes a number`);
        return n;
      }
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
          throw new NameError(`${field.name} takes a date as YYYY-MM-DD`);
        return value;
      case 'person':
        return this.member(value).id;
      default:
        return value;
    }
  }

  /** A stored value written out: option names, a number, date or text, or `@username`. */
  fieldText(field: CustomField, value: CustomFieldValue): string {
    if (field.type === 'person') {
      const m = this.boot.members.find((x) => x.id === value);
      return m ? `@${m.username}` : 'someone';
    }
    if (field.type === 'select' || field.type === 'multi_select')
      return (Array.isArray(value) ? value : [String(value)])
        .map((id) => field.options.find((o) => o.id === id)?.name ?? '?')
        .join(', ');
    return String(value);
  }

  project(ref: string): Project {
    const r = norm(ref);
    const project = this.boot.projects.find((p) => p.id === ref || norm(p.name) === r);
    if (!project)
      throw new NameError(
        `No project "${ref}". Projects: ${list(this.boot.projects.map((p) => p.name))}`,
      );
    return project;
  }

  /** `current`, `next`, or a cycle number, in a team. */
  cycle(team: Team, ref: string): Cycle {
    // The workspace's day, the one cycle automation opens and closes cycles by.
    const now = dayInZone(this.boot.workspace.settings.timezone);
    const cycles = this.boot.cycles
      .filter((c) => c.teamId === team.id)
      .sort((a, b) => a.number - b.number);
    const r = norm(ref);
    const cycle =
      r === 'current'
        ? cycles.find((c) => isCycleCurrent(c, now))
        : r === 'next'
          ? cycles.find((c) => c.startsAt.slice(0, 10) > now)
          : cycles.find((c) => c.id === ref || String(c.number) === r.replace(/^#/, ''));
    if (!cycle)
      throw new NameError(
        `No ${r === 'current' || r === 'next' ? r : `"${ref}"`} cycle in ${team.key}`,
      );
    return cycle;
  }
}

/** `urgent`, `high`, `medium`, `low`, `none` or 0–4. */
export function parsePriority(ref: string | number): number {
  const r = norm(String(ref));
  const p = PRIORITIES.find((x) => String(x.value) === r || norm(x.label) === r);
  if (p) return p.value;
  if (r === 'none') return 0;
  throw new NameError(`No priority "${ref}". Use urgent, high, medium, low or none`);
}
