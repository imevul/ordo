import {
  type Bootstrap,
  type Cycle,
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
 * `me`/usernames/emails, project names, `current`/cycle numbers and priority words. Works from a
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
    const now = new Date().toISOString().slice(0, 10);
    const cycles = this.boot.cycles
      .filter((c) => c.teamId === team.id)
      .sort((a, b) => a.number - b.number);
    const r = norm(ref);
    const cycle =
      r === 'current'
        ? cycles.find((c) => c.startsAt.slice(0, 10) <= now && now <= c.endsAt.slice(0, 10))
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
