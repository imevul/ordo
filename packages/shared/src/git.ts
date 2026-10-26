import type { StateType } from './constants.ts';

/** Moments in a branch's or pull request's life that can move its issues. */
export const GIT_EVENTS = ['branch', 'draft', 'open', 'review', 'merged'] as const;
export type GitEvent = (typeof GIT_EVENTS)[number];

export const GIT_EVENT_LABELS: Record<GitEvent, string> = {
  branch: 'Branch pushed',
  draft: 'Draft PR opened',
  open: 'PR opened',
  review: 'Review requested',
  merged: 'PR merged',
};

/** Per team: a status id to move linked issues to, or "none". Missing events use the defaults. */
export type GitAutomation = Partial<Record<GitEvent, string>>;

/**
 * Defaults by status type: drafts and open PRs → the first "started" status, review → a started
 * status named like "review", merged → the first "completed" status. Pushing a branch does nothing.
 */
export function defaultGitAutomation(
  states: { id: string; name: string; type: StateType; position: number }[],
): Record<GitEvent, string | null> {
  const ordered = [...states].sort((a, b) => a.position - b.position);
  const started = ordered.filter((s) => s.type === 'started');
  const firstStarted = started[0]?.id ?? null;
  return {
    branch: null,
    draft: firstStarted,
    open: firstStarted,
    review: started.find((s) => /review/i.test(s.name))?.id ?? null,
    merged: ordered.find((s) => s.type === 'completed')?.id ?? null,
  };
}

/** The effective target status for an event, or null for "leave it". */
export function gitAutomationTarget(
  automation: GitAutomation | null | undefined,
  states: { id: string; name: string; type: StateType; position: number }[],
  event: GitEvent,
): string | null {
  const configured = automation?.[event];
  if (configured === 'none') return null;
  if (configured && states.some((s) => s.id === configured)) return configured;
  return defaultGitAutomation(states)[event];
}

export const DEFAULT_BRANCH_FORMAT = '{username}/{identifier}-{title}';

/** A git branch name for an issue, from a format with {identifier}, {title} and {username}. */
export function branchName(
  format: string,
  vars: { identifier: string; title: string; username: string },
): string {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const name = (format || DEFAULT_BRANCH_FORMAT)
    .replaceAll('{identifier}', vars.identifier.toLowerCase())
    .replaceAll('{title}', slug(vars.title).slice(0, 40).replace(/-+$/, ''))
    .replaceAll('{username}', slug(vars.username));
  // Collapse what empty parts leave behind; git refuses "//", leading "/" and trailing "-" or ".".
  return name
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[/-]+|[/.-]+$/g, '');
}
