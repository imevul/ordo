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

/** Priorities: 0 = none, 1 = urgent … 4 = low. */
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

export const RECURRENCE_UNITS = ['day', 'week', 'month'] as const;
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

export const INITIATIVE_STATUSES = ['planned', 'active', 'completed'] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

export const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
export type ProjectHealth = (typeof PROJECT_HEALTH)[number];

/** Stored relation types. "blocked by" is the inverse of "blocks". */
export const RELATION_TYPES = ['blocks', 'related', 'duplicate'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * owner: everything, including ownership and deleting the org. admin: manage members, teams and settings.
 * member: work in every public team and their private teams. guest: only teams they were added to.
 */
export const MEMBER_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
// Role checks go through these helpers, never string comparisons.
type MaybeRole = string | null | undefined;
export const isOwnerRole = (role: MaybeRole) => role === 'owner';
export const isAdminRole = (role: MaybeRole) => role === 'owner' || role === 'admin';
export const isGuestRole = (role: MaybeRole) => role === 'guest';

export const TEAM_ROLES = ['admin', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const isTeamAdminRole = (role: MaybeRole) => role === 'admin';

/**
 * Only humans sign in. Agents are assignable members that act through an API key (a runner does
 * their work). Bots act for integrations; placeholders stand in for unmapped imported people.
 */
export const USER_KINDS = ['human', 'agent', 'bot', 'placeholder'] as const;
export type UserKind = (typeof USER_KINDS)[number];

export const AUDIT_ACTIONS = [
  'auth.signup',
  'auth.login',
  'auth.login_failed',
  'auth.confirm_failed',
  'auth.logout',
  'auth.password_changed',
  'auth.email_changed',
  'auth.2fa_enabled',
  'auth.2fa_disabled',
  'auth.passkey_added',
  'auth.passkey_removed',
  'auth.session_revoked',
  'auth.identity_linked',
  'auth.identity_unlinked',
  'auth.sso_bypass',
  'sso.provider_created',
  'sso.provider_updated',
  'sso.provider_deleted',
  'scim.token_created',
  'scim.token_deleted',
  'scim.group_linked',
  'scim.group_unlinked',
  'webhook.created',
  'webhook.updated',
  'webhook.deleted',
  'webhook.disabled',
  'integration.created',
  'integration.updated',
  'integration.deleted',
  'chat_account.linked',
  'chat_account.unlinked',
  'import.started',
  'import.completed',
  'import.failed',
  'import.canceled',
  'import.undone',
  'placeholder.merged',
  'api_key.created',
  'api_key.revoked',
  'calendar_feed.created',
  'calendar_feed.revoked',
  'oauth.authorized',
  'oauth.revoked',
  'workspace.created',
  'workspace.updated',
  'workspace.deleted',
  'workspace.exported',
  'workspace.ai_updated',
  'member.suspended',
  'member.unsuspended',
  'domain.added',
  'domain.verified',
  'domain.removed',
  'admin.user_updated',
  'admin.user_deleted',
  'admin.invite_created',
  'admin.invite_revoked',
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
  'agent.created',
  'agent.updated',
  'agent.disabled',
  'agent.unpaused',
  'agent.key_created',
  'repository.created',
  'repository.updated',
  'repository.deleted',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Groups of audit actions, by prefix, for filtering the audit log. */
export const AUDIT_CATEGORIES = {
  security: ['auth.', 'sso.', 'scim.', 'api_key.', 'calendar_feed.', 'oauth.', 'domain.'],
  members: ['member.', 'invite.', 'placeholder.', 'admin.'],
  teams: ['team.'],
  workspace: ['workspace.', 'settings.'],
  integrations: ['integration.', 'webhook.', 'chat_account.', 'agent.', 'repository.'],
  imports: ['import.'],
} as const satisfies Record<string, readonly string[]>;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const NOTIFICATION_TYPES = [
  'issue_assigned',
  'issue_unassigned',
  'issue_comment',
  'issue_mention',
  'issue_status_changed',
  'issue_priority_urgent',
  'comment_reaction',
  'issue_sla_breached',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Statuses people can set on themselves; "available" is no status at all. */
export const USER_STATUSES = ['away', 'meeting', 'focus', 'dnd', 'sick', 'vacation'] as const;
export type UserStatusKind = (typeof USER_STATUSES)[number];

/** Pausing pings: `mentions` lets mentions (and SLA breaches) through, `all` lets nothing through. */
export const NOTIFY_PAUSES = ['mentions', 'all'] as const;
export type NotifyPauseMode = (typeof NOTIFY_PAUSES)[number];

/** How long a status or pause lasts, before it's turned into a time in the person's own zone. */
export const STATUS_DURATIONS = ['30m', '1h', '2h', '4h', 'today', 'week', 'never'] as const;
export type StatusDuration = (typeof STATUS_DURATIONS)[number];

/** What each status suggests: an emoji, how it pauses notifications, and when it clears. */
export const USER_STATUS_PRESETS: Record<
  UserStatusKind,
  { emoji: string; pause: NotifyPauseMode | null; clearAfter: StatusDuration }
> = {
  away: { emoji: '🚶', pause: null, clearAfter: '1h' },
  meeting: { emoji: '📅', pause: 'mentions', clearAfter: '1h' },
  focus: { emoji: '🎧', pause: 'mentions', clearAfter: '2h' },
  dnd: { emoji: '⛔', pause: 'all', clearAfter: 'today' },
  sick: { emoji: '🤒', pause: 'all', clearAfter: 'today' },
  vacation: { emoji: '🌴', pause: 'all', clearAfter: 'week' },
};

/** Statuses that warn people who assign or mention someone: they won't see it soon. */
export const UNAVAILABLE_STATUSES: readonly UserStatusKind[] = ['dnd', 'sick', 'vacation'];

/** Notification types a `mentions` pause still pings for. */
export const PAUSE_PASSES: readonly NotificationType[] = ['issue_mention', 'issue_sla_breached'];

/** Why someone got a notification, stored as `data.reason`; older rows have none and count as `subscriber`. */
export const NOTIFICATION_REASONS = ['assignee', 'creator', 'subscriber', 'mention'] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

/** The reactions offered first; any single emoji is accepted. */
export const QUICK_REACTIONS = ['👍', '👎', '❤️', '🎉', '😄', '😕', '🚀', '👀'] as const;
/** Distinct emoji one comment can collect, so reactions stay a row and not a wall. */
export const MAX_REACTION_KINDS = 20;

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

/** Attachment URLs are slug-free so renaming a workspace doesn't break them in Markdown. */
export const attachmentUrl = (id: string) => `/api/attachments/${id}`;
/** The Markdown that shows an attachment: inline for images, a link for anything else. */
export const attachmentMarkdown = (att: { filename: string; contentType: string; url: string }) => {
  const name = att.filename.replace(/[[\]\\]/g, '');
  return att.contentType.startsWith('image/') ? `![${name}](${att.url})` : `[${name}](${att.url})`;
};
/** Finds attachment ids referenced in Markdown (relative or absolute URLs). */
export const ATTACHMENT_URL_PATTERN =
  /\/api\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** Events in the outbox, delivered to webhooks and integrations. Names are part of the public API. */
export const DOMAIN_EVENT_TYPES = [
  'issue.created',
  'issue.updated',
  'issue.trashed',
  'issue.restored',
  'issue.deleted',
  'issue.archived',
  'issue.unarchived',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'reaction.created',
  'reaction.deleted',
  'relation.created',
  'relation.deleted',
  'project.created',
  'project.updated',
  'project.deleted',
  'initiative.created',
  'initiative.updated',
  'initiative.deleted',
  'project_update.created',
  'cycle.created',
  'cycle.updated',
  'cycle.deleted',
  'release.created',
  'release.updated',
  'release.released',
  'release.reopened',
  'release.deleted',
  'agent_run.updated',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** What a chat channel can subscribe to. `issue.status` includes `issue.completed`. */
export const CHAT_EVENT_KINDS = [
  'issue.created',
  'issue.status',
  'issue.completed',
  'comment.created',
  'project_update.created',
] as const;
export type ChatEventKind = (typeof CHAT_EVENT_KINDS)[number];

/**
 * queued: waiting for a runner. claimed: a runner took it and holds the lease. running: the
 * runner said it started. waiting: the agent asked a question; a person's comment requeues it.
 * The rest are final.
 */
export const AGENT_RUN_STATUSES = [
  'queued',
  'claimed',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export const AGENT_RUN_OPEN: readonly AgentRunStatus[] = [
  'queued',
  'claimed',
  'running',
  'waiting',
];
/**
 * Why a run failed, as far as Ordo can tell. usage_limit: the agent's account hit a usage or spend
 * limit (the agent pauses and the run restarts when the limit resets). runner_lost: its runner
 * stopped responding on the last attempt. error: anything else, usually a non-zero exit.
 */
export const AGENT_RUN_FAILURE_REASONS = [
  'usage_limit',
  'timeout',
  'runner_lost',
  'checkout',
  'error',
] as const;
export type AgentRunFailureReason = (typeof AGENT_RUN_FAILURE_REASONS)[number];
/**
 * Why an agent's claims are on hold: its runner hit a usage limit, or it spent its monthly budget
 * (it's paused until the next month starts, in UTC).
 */
export const AGENT_PAUSE_REASONS = ['usage_limit', 'budget'] as const;
export type AgentPauseReason = (typeof AGENT_PAUSE_REASONS)[number];
/** Usage-limit failures in a row after which a run waits for a person instead of restarting. */
export const AGENT_AUTO_RESTARTS = 3;
/**
 * Why a run exists: its agent was assigned the issue, a person @mentioned it, Run again,
 * something happened to one of the issue's pull requests (see `AgentRun.triggerDetail`), or a
 * recurring schedule created the issue with the agent as assignee.
 */
export const AGENT_RUN_TRIGGERS = [
  'assigned',
  'mention',
  'rerun',
  'pull_request',
  'scheduled',
] as const;
export type AgentRunTrigger = (typeof AGENT_RUN_TRIGGERS)[number];
/** The runner protocol's version, in every claimed run's context. */
export const AGENT_PROTOCOL_VERSION = 1;

export const ISSUE_LINK_KINDS = [
  'pull_request',
  'branch',
  'commit',
  'message',
  'link',
  /** An issue in another tracker (Jira). */
  'external_issue',
] as const;
export type IssueLinkKind = (typeof ISSUE_LINK_KINDS)[number];

/** Languages the web app, emails and notifications are translated into. English is the default and fallback. */
export const LOCALES = ['en', 'sv', 'nb'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
/** Each language's name in itself, for pickers. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  sv: 'Svenska',
  nb: 'Norsk bokmål',
};

/**
 * Errors the web app shows in the reader's language. The API adds `messageKey` (and `params`) to
 * these error responses; anything without a key is shown as the API's English `message`.
 */
export const API_MESSAGE_KEYS = [
  'not_signed_in',
  'no_access',
  'not_found',
  'wrong_credentials',
  'too_many_attempts',
  'invalid_code',
  'invalid_code_time',
  'sign_in_again',
  'current_password_wrong',
  'link_invalid',
  'invite_invalid',
  'invite_other_email',
  'invite_required',
  'invite_needed',
  'invite_already_signed_up',
  'account_disabled',
  'email_taken',
  'same_email',
  'sso_no_password',
  'two_factor_already_on',
  'sign_in_expired',
  'sign_in_expired_browser',
  'sign_in_method_gone',
  'link_other_person',
  'sign_in_first',
  'username_taken',
  'workspace_url_taken',
  'domain_verified_elsewhere',
  'domain_added',
  'team_key_taken',
  'type_url_to_confirm',
  'owners_only',
  'admins_only',
  'team_admins_only',
  'admins_invite',
  'team_admins_add',
  'owners_remove_owner',
  'owners_grant',
  'admins_remove_members',
  'admins_invite_admins',
  'instance_admins_only',
  'own_comments_edit',
  'own_comments_delete',
  'attachment_remove',
  'view_change',
  'guests_customers',
  'guests_cycles',
  'guests_releases',
  'release_frozen',
  'release_out',
  'release_not_out',
  'unknown_release',
  'guests_projects',
  'guests_documents',
  'guests_own',
  'workspace_creation_off',
  'needs_owner',
  'needs_team',
  'only_status',
  'sub_issue_loop',
  'own_parent',
  'relate_self',
  'end_after_start',
  'no_file',
  'image_type',
  'file_too_large',
  'file_empty',
  'document_conflict',
  'import_busy',
  'export_busy',
  'export_not_ready',
  'ai_not_set_up',
  'ai_not_set_up_workspace',
  'ai_own_not_allowed',
  'passkey_failed',
  'invalid_certificate',
  'team_managed',
  'resync',
  'id_taken',
  'reauth_needed',
  'ai_locked',
  'ai_off_workspace',
  'ai_off',
  'ai_empty',
  'not_member',
  'pick_member',
  'webhook_off',
  'webhook_url',
  'unknown_team',
  'unknown_parent',
  'unknown_project',
  'unknown_label',
  'unknown_milestone',
  'unknown_initiative',
  'unknown_template',
  'default_team_public',
  'already_owner',
  'sso_required',
  'api_keys_not_allowed',
  'username_claimed',
  'attachment_too_large',
  'max_reactions',
] as const;
export type ApiMessageKey = (typeof API_MESSAGE_KEYS)[number];

/** What a SAML identity provider needs to know about Ordo, for one provider. */
export const samlServiceProvider = (publicUrl: string, providerId: string) => {
  const base = `${publicUrl.replace(/\/+$/, '')}/api/auth/saml/${providerId}`;
  // The metadata's own address doubles as the entity ID, as most IdPs expect.
  return { entityId: `${base}/metadata`, acsUrl: `${base}/acs`, metadataUrl: `${base}/metadata` };
};
