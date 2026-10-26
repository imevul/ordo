import type {
  AuditAction,
  EstimateScale,
  FavoriteKind,
  HistoryChange,
  IssueDisplay,
  IssueFilter,
  MemberRole,
  NotificationType,
  ProjectHealth,
  ProjectStatus,
  RelationType,
  StateType,
  TeamRole,
  UserKind,
  UserPreferences,
  WorkspaceSettings,
} from '@ordo/shared';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Note: only type imports from @ordo/shared here, so drizzle-kit can load this file standalone.

/** timestamptz exposed as an ISO-8601 string ("2026-01-31T09:00:00.000Z") instead of Postgres' text form. */
const timestamptz = customType<{ data: string; driverData: string | Date }>({
  dataType: () => 'timestamp with time zone',
  fromDriver: (v) =>
    v instanceof Date
      ? v.toISOString()
      : new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString(),
  toDriver: (v) => v,
});

const pk = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamptz(name);
const createdAt = () => ts('created_at').notNull().default(sql`now()`);
const updatedAt = () => ts('updated_at').notNull().default(sql`now()`);

export const users = pgTable('users', {
  id: pk(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  username: text('username').notNull().unique(),
  /** Null for accounts that only sign in through SSO, and for bot/placeholder users. */
  passwordHash: text('password_hash'),
  avatarColor: text('avatar_color').notNull().default('#ff1493'),
  /** human: a person; bot: acts for an integration; placeholder: an unmapped imported person. Only humans log in. */
  kind: text('kind').$type<UserKind>().notNull().default('human'),
  isInstanceAdmin: boolean('is_instance_admin').notNull().default(false),
  emailVerifiedAt: ts('email_verified_at'),
  disabledAt: ts('disabled_at'),
  avatarFileId: uuid('avatar_file_id'),
  /** TOTP secret, encrypted with the keyring (aad users:<id>:totp_secret). Set but unused until enabled. */
  totpSecret: text('totp_secret'),
  totpEnabledAt: ts('totp_enabled_at'),
  preferences: jsonb('preferences').$type<Partial<UserPreferences>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the cookie token — the raw token is never stored. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    lastSeenAt: ts('last_seen_at'),
    /** Set when the session came from an organisation's SSO provider (see Phase 5). */
    authProviderId: uuid('auth_provider_id'),
    ssoExpiresAt: ts('sso_expires_at'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const apiKeys = pgTable('api_keys', {
  id: pk(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  lastUsedAt: ts('last_used_at'),
  createdAt: createdAt(),
});

export const workspaces = pgTable('workspaces', {
  id: pk(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logoFileId: uuid('logo_file_id'),
  /** Team new members join automatically, and the default for new issues. */
  defaultTeamId: uuid('default_team_id'),
  settings: jsonb('settings').$type<Partial<WorkspaceSettings>>().notNull().default({}),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<MemberRole>().notNull().default('member'),
    joinedAt: ts('joined_at').notNull().default(sql`now()`),
    /** Suspended members keep their history but can't open the workspace. */
    suspendedAt: ts('suspended_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user_idx').on(t.userId),
  ],
);

export const invites = pgTable('invites', {
  id: pk(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  email: text('email'),
  role: text('role').$type<MemberRole>().notNull().default('member'),
  /** Teams the invitee joins on accepting. */
  teamIds: jsonb('team_ids').$type<string[]>().notNull().default([]),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  lastSentAt: ts('last_sent_at'),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  createdAt: createdAt(),
});

export const teams = pgTable(
  'teams',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    key: text('key').notNull(),
    description: text('description'),
    color: text('color').notNull().default('#ff1493'),
    issueCounter: integer('issue_counter').notNull().default(0),
    cycleCounter: integer('cycle_counter').notNull().default(0),
    estimateScale: text('estimate_scale').$type<EstimateScale>().notNull().default('fibonacci'),
    triageEnabled: boolean('triage_enabled').notNull().default(false),
    /** Private teams are visible only to their members and workspace admins. */
    private: boolean('private').notNull().default(false),
    cyclesEnabled: boolean('cycles_enabled').notNull().default(true),
    defaultStateId: uuid('default_state_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('teams_workspace_key_idx').on(t.workspaceId, t.key)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Team admins manage the team's settings, workflow and membership. */
    role: text('role').$type<TeamRole>().notNull().default('member'),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_members_user_idx').on(t.userId),
  ],
);

export const workflowStates = pgTable(
  'workflow_states',
  {
    id: pk(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<StateType>().notNull(),
    color: text('color').notNull(),
    description: text('description'),
    position: doublePrecision('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('workflow_states_team_idx').on(t.teamId)],
);

export const labels = pgTable(
  'labels',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('labels_workspace_idx').on(t.workspaceId)],
);

export const projects = pgTable(
  'projects',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color').notNull().default('#ff1493'),
    status: text('status').$type<ProjectStatus>().notNull().default('planned'),
    leadId: uuid('lead_id').references(() => users.id, { onDelete: 'set null' }),
    startDate: date('start_date', { mode: 'string' }),
    targetDate: date('target_date', { mode: 'string' }),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_workspace_idx').on(t.workspaceId)],
);

export const projectTeams = pgTable(
  'project_teams',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.teamId] })],
);

export const projectUpdates = pgTable(
  'project_updates',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    health: text('health').$type<ProjectHealth>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('project_updates_project_idx').on(t.projectId)],
);

export const cycles = pgTable(
  'cycles',
  {
    id: pk(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    name: text('name'),
    description: text('description'),
    startsAt: date('starts_at', { mode: 'string' }).notNull(),
    endsAt: date('ends_at', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('cycles_team_number_idx').on(t.teamId, t.number)],
);

export const issues = pgTable(
  'issues',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    stateId: uuid('state_id')
      .notNull()
      .references(() => workflowStates.id),
    priority: integer('priority').notNull().default(0),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    creatorId: uuid('creator_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    cycleId: uuid('cycle_id').references(() => cycles.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id'),
    estimate: integer('estimate'),
    dueDate: date('due_date', { mode: 'string' }),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    canceledAt: ts('canceled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('issues_team_number_idx').on(t.teamId, t.number),
    index('issues_workspace_idx').on(t.workspaceId),
    index('issues_state_idx').on(t.stateId),
    index('issues_assignee_idx').on(t.assigneeId),
    index('issues_project_idx').on(t.projectId),
    index('issues_cycle_idx').on(t.cycleId),
    index('issues_parent_idx').on(t.parentId),
  ],
);

export const issueLabels = pgTable(
  'issue_labels',
  {
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    index('issue_labels_label_idx').on(t.labelId),
  ],
);

export const issueRelations = pgTable(
  'issue_relations',
  {
    id: pk(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    relatedIssueId: uuid('related_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    type: text('type').$type<RelationType>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('issue_relations_issue_idx').on(t.issueId),
    index('issue_relations_related_idx').on(t.relatedIssueId),
  ],
);

export const issueSubscribers = pgTable(
  'issue_subscribers',
  {
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.userId] }),
    index('issue_subscribers_user_idx').on(t.userId),
  ],
);

export const issueHistory = pgTable(
  'issue_history',
  {
    id: pk(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    changes: jsonb('changes').$type<HistoryChange[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('issue_history_issue_idx').on(t.issueId)],
);

export const comments = pgTable(
  'comments',
  {
    id: pk(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id'),
    body: text('body').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    editedAt: ts('edited_at'),
  },
  (t) => [index('comments_issue_idx').on(t.issueId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<NotificationType>().notNull(),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    readAt: ts('read_at'),
    /** Set once the notification went out by email (or was skipped by preferences). */
    emailedAt: ts('emailed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.workspaceId)],
);

export const views = pgTable(
  'views',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    shared: boolean('shared').notNull().default(true),
    filters: jsonb('filters').$type<IssueFilter>().notNull(),
    display: jsonb('display').$type<IssueDisplay>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('views_workspace_idx').on(t.workspaceId)],
);

export const favorites = pgTable(
  'favorites',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<FavoriteKind>().notNull(),
    targetId: uuid('target_id').notNull(),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('favorites_unique_idx').on(t.userId, t.workspaceId, t.kind, t.targetId)],
);

/** Security-relevant actions, written in the same transaction as the change they record. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    /** Null for instance-level events (sign-in, instance settings…). */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').$type<AuditAction>().notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_workspace_idx').on(t.workspaceId, t.createdAt),
    index('audit_log_actor_idx').on(t.actorId, t.createdAt),
  ],
);

/** Instance-wide settings managed by instance admins; environment variables take precedence. */
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

/** One-time tokens sent by email (password reset, email verification/change) or used between login steps (MFA). */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<'password_reset' | 'email_verify' | 'email_change' | 'mfa'>()
      .notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('auth_tokens_user_idx').on(t.userId, t.kind)],
);

export const recoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('mfa_recovery_codes_user_idx').on(t.userId)],
);

/** Uploaded files. The bytes live in the storage backend under `storage_key`. */
export const files = pgTable(
  'files',
  {
    id: pk(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').$type<'avatar' | 'logo' | 'attachment' | 'import'>().notNull(),
    storageKey: text('storage_key').notNull().unique(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('files_workspace_idx').on(t.workspaceId)],
);

/**
 * Background jobs. Workers claim rows with FOR UPDATE SKIP LOCKED; jobs sharing an
 * ordering_key run one at a time in id order. Finished jobs are deleted; dead ones are kept.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull().default({}),
    status: text('status').$type<'pending' | 'running' | 'dead'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    runAt: ts('run_at').notNull().default(sql`now()`),
    lockedUntil: ts('locked_until'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    orderingKey: text('ordering_key'),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
  },
  (t) => [
    index('jobs_runnable_idx').on(t.status, t.runAt),
    index('jobs_ordering_idx').on(t.orderingKey, t.id),
    uniqueIndex('jobs_dedupe_idx').on(t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);

/** Recurring jobs: whichever instance advances `next_run_at` first enqueues the run. */
export const schedules = pgTable('schedules', {
  name: text('name').primaryKey(),
  intervalSeconds: integer('interval_seconds').notNull(),
  nextRunAt: ts('next_run_at').notNull(),
  lastRunAt: ts('last_run_at'),
});

/** Time-limited leases for singleton work (long-lived connectors); `fencing` increases on every takeover. */
export const leases = pgTable('leases', {
  key: text('key').primaryKey(),
  holder: text('holder').notNull(),
  fencing: integer('fencing').notNull().default(1),
  expiresAt: ts('expires_at').notNull(),
});

/**
 * Email domains a workspace has proven it owns (DNS TXT record, or approved by an instance admin).
 * Verified domains enable auto-join and, later, SSO discovery.
 */
export const workspaceDomains = pgTable(
  'workspace_domains',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    /** Value expected in the `_ordo-verify.<domain>` TXT record. */
    verificationToken: text('verification_token').notNull(),
    verifiedAt: ts('verified_at'),
    verifiedBy: text('verified_by').$type<'dns' | 'instance_admin'>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('workspace_domains_unique_idx').on(t.workspaceId, t.domain),
    index('workspace_domains_domain_idx').on(t.domain),
  ],
);

/** An organisation's OpenID Connect identity provider (Authentik, Keycloak, Entra ID, Google…). */
export const authProviders = pgTable(
  'auth_providers',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    /** Encrypted (aad auth_providers:<id>:client_secret). */
    clientSecret: text('client_secret').notNull(),
    scopes: text('scopes').notNull().default('openid email profile'),
    enabled: boolean('enabled').notNull().default(true),
    /** Role for people who join through this provider. */
    defaultRole: text('default_role').$type<'member' | 'guest'>().notNull().default('member'),
    /** Claim holding group names (e.g. "groups"); with `groupRoles`, sets roles at every sign-in. */
    groupClaim: text('group_claim'),
    groupRoles: jsonb('group_roles')
      .$type<Record<string, 'admin' | 'member' | 'guest'>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('auth_providers_workspace_idx').on(t.workspaceId)],
);

/** A user's account at an identity provider (provider + subject), linked to an Ordo user. */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => authProviders.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    email: text('email'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_identities_subject_idx').on(t.providerId, t.subject),
    index('user_identities_user_idx').on(t.userId),
  ],
);

/** In-flight OIDC logins: binds the callback to the provider, PKCE verifier and nonce that started it. */
export const authStates = pgTable('auth_states', {
  /** The `state` parameter (random). */
  id: text('id').primaryKey(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => authProviders.id, { onDelete: 'cascade' }),
  nonce: text('nonce').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  /** login | link (attach to `userId`) | test (show claims to an admin). */
  mode: text('mode').$type<'login' | 'link' | 'test'>().notNull().default('login'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  redirect: text('redirect'),
  expiresAt: ts('expires_at').notNull(),
});
