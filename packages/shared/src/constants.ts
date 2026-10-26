/** Workflow state categories. Every team-defined state belongs to exactly one type. */
export const STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export type StateType = (typeof STATE_TYPES)[number];

export const STATE_TYPE_LABELS: Record<StateType, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  unstarted: 'Unstarted',
  started: 'Started',
  completed: 'Completed',
  canceled: 'Canceled',
};

/** States created for every new team. */
export const DEFAULT_WORKFLOW_STATES: { name: string; type: StateType; color: string }[] = [
  { name: 'Triage', type: 'triage', color: '#f59e0b' },
  { name: 'Backlog', type: 'backlog', color: '#b8aab2' },
  { name: 'Todo', type: 'unstarted', color: '#b8aab2' },
  { name: 'In Progress', type: 'started', color: '#f59e0b' },
  { name: 'In Review', type: 'started', color: '#ff5cb8' },
  { name: 'Done', type: 'completed', color: '#22c55e' },
  { name: 'Canceled', type: 'canceled', color: '#8e7985' },
  { name: 'Duplicate', type: 'canceled', color: '#8e7985' },
];

/** Priorities follow Linear's convention: 0 = none, 1 = urgent … 4 = low. */
export const PRIORITIES = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
] as const;
export type Priority = 0 | 1 | 2 | 3 | 4;

export const priorityLabel = (p: number) =>
  PRIORITIES.find((x) => x.value === p)?.label ?? 'No priority';

/** Sort key where urgent comes first and "no priority" last. */
export const prioritySortKey = (p: number) => (p === 0 ? 5 : p);

export const ESTIMATE_SCALES = {
  none: [],
  linear: [1, 2, 3, 4, 5],
  fibonacci: [1, 2, 3, 5, 8, 13],
  exponential: [1, 2, 4, 8, 16],
  tshirt: [1, 2, 3, 5, 8],
} as const satisfies Record<string, readonly number[]>;
export type EstimateScale = keyof typeof ESTIMATE_SCALES;
export const ESTIMATE_SCALE_NAMES = Object.keys(ESTIMATE_SCALES) as EstimateScale[];

const TSHIRT: Record<number, string> = { 1: 'XS', 2: 'S', 3: 'M', 5: 'L', 8: 'XL' };
export const estimateLabel = (scale: EstimateScale, value: number | null | undefined) => {
  if (value == null) return 'No estimate';
  if (scale === 'tshirt') return TSHIRT[value] ?? `${value}`;
  return `${value} ${value === 1 ? 'point' : 'points'}`;
};

export const PROJECT_STATUSES = [
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  started: 'In Progress',
  paused: 'Paused',
  completed: 'Completed',
  canceled: 'Canceled',
};

export const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
export type ProjectHealth = (typeof PROJECT_HEALTH)[number];
export const PROJECT_HEALTH_LABELS: Record<ProjectHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};

/** Stored relation types. "blocked by" is the inverse of "blocks". */
export const RELATION_TYPES = ['blocks', 'related', 'duplicate'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * owner: everything, including ownership and deleting the org. admin: manage members, teams and settings.
 * member: work in every public team and their private teams. guest: only teams they were added to.
 */
export const MEMBER_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export const MEMBER_ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
} as const;
export const isAdminRole = (role: string) => role === 'owner' || role === 'admin';

export const TEAM_ROLES = ['admin', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Only humans sign in. Bots act for integrations; placeholders stand in for unmapped imported people. */
export const USER_KINDS = ['human', 'bot', 'placeholder'] as const;
export type UserKind = (typeof USER_KINDS)[number];

export const AUDIT_ACTIONS = [
  'auth.signup',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'api_key.created',
  'api_key.revoked',
  'workspace.created',
  'workspace.updated',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'invite.created',
  'invite.revoked',
  'invite.accepted',
  'team.created',
  'team.updated',
  'team.deleted',
  'team.member_added',
  'team.member_removed',
  'team.member_role_changed',
  'settings.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const NOTIFICATION_TYPES = [
  'issue_assigned',
  'issue_unassigned',
  'issue_comment',
  'issue_mention',
  'issue_status_changed',
  'issue_priority_urgent',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const FAVORITE_KINDS = ['issue', 'project', 'view', 'cycle', 'team'] as const;
export type FavoriteKind = (typeof FAVORITE_KINDS)[number];

/** Label palette tuned to sit on the Hotline Pink charcoal ground. */
export const LABEL_COLORS = [
  '#ff1493',
  '#ff5cb8',
  '#2de2e6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a78bfa',
  '#60a5fa',
  '#b8aab2',
  '#8e7985',
  '#fb923c',
  '#facc15',
];

export const AVATAR_COLORS = [
  '#ff1493',
  '#c6006f',
  '#ff5cb8',
  '#2de2e6',
  '#22c55e',
  '#f59e0b',
  '#a78bfa',
  '#60a5fa',
];

export const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,6}$/;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const USERNAME_PATTERN = /^[a-z0-9._-]{2,32}$/;
/** Matches identifiers like ENG-123. */
export const ISSUE_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9]{0,6})-(\d+)$/;
