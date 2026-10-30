import type {
  AgentRunPullRequest,
  AgentRunStatus,
  AgentRunTrigger,
  AuditAction,
  CycleAutomation,
  DomainEventType,
  EstimateScale,
  ExportFormat,
  FavoriteKind,
  GitAutomation,
  HistoryChange,
  ImportMapping,
  ImportProgress,
  ImportReport,
  ImportSource,
  ImportStatus,
  ImportSummary,
  InitiativeStatus,
  IssueDisplay,
  IssueFilter,
  IssueLinkKind,
  MemberRole,
  NotificationType,
  NotifyPauseMode,
  ProjectHealth,
  ProjectStatus,
  PullRequestScope,
  RecurrenceUnit,
  RelationType,
  SamlSettings,
  SlaHours,
  StateType,
  TeamRole,
  TriageActions,
  TriageConditions,
  UserKind,
  UserPreferences,
  UserStatusKind,
  WebhookPayload,
  WorkspaceSettings,
} from '@ordo/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
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
  /**
   * human: a person; agent: an assignable member that acts through API keys (see `agents`); bot:
   * acts for an integration; placeholder: an unmapped imported person. Only humans log in.
   */
  kind: text('kind').$type<UserKind>().notNull().default('human'),
  isInstanceAdmin: boolean('is_instance_admin').notNull().default(false),
  /** May create workspaces even when the instance turns workspace creation off. */
  canCreateWorkspaces: boolean('can_create_workspaces').notNull().default(false),
  /**
   * Set when the account came from a site invite. Such accounts don't get the usual "anyone may
   * create their first workspace" allowance; only `canCreateWorkspaces` lets them.
   */
  siteInvitedAt: ts('site_invited_at'),
  emailVerifiedAt: ts('email_verified_at'),
  disabledAt: ts('disabled_at'),
  avatarFileId: uuid('avatar_file_id'),
  /** TOTP secret, encrypted with the keyring (aad users:<id>:totp_secret). Set but unused until enabled. */
  totpSecret: text('totp_secret'),
  totpEnabledAt: ts('totp_enabled_at'),
  /** The last 30-second step a code was accepted for; each step's code works once. */
  totpLastStep: integer('totp_last_step'),
  preferences: jsonb('preferences').$type<Partial<UserPreferences>>().notNull().default({}),
  /** Status others see (`UserStatus`); account-wide, read as cleared once `status_until` passed. */
  statusKind: text('status_kind').$type<UserStatusKind>(),
  statusEmoji: text('status_emoji'),
  statusText: text('status_text'),
  statusUntil: ts('status_until'),
  /** Pings held back (`NotifyPause`), private; null until: until turned off. */
  notifyPause: text('notify_pause').$type<NotifyPauseMode>(),
  notifyPauseUntil: ts('notify_pause_until'),
  /**
   * For bots and agents: the workspace they act in (outlives the integration, so its history keeps a name).
   * For placeholders: the workspace whose import made them.
   */
  botWorkspaceId: uuid('bot_workspace_id').references((): AnyPgColumn => workspaces.id, {
    onDelete: 'set null',
  }),
  /** For placeholders: the email the source had, for matching them to a member later. */
  importedEmail: text('imported_email'),
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
  /** Null for a site invite: an account on the instance, made by an instance admin, no workspace. */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  email: text('email'),
  role: text('role').$type<MemberRole>().notNull().default('member'),
  /** Teams the invitee joins on accepting. */
  teamIds: jsonb('team_ids').$type<string[]>().notNull().default([]),
  /** Site invites: copied to `users.can_create_workspaces` on sign-up. */
  canCreateWorkspaces: boolean('can_create_workspaces').notNull().default(false),
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
    /** Where agents work on the team's issues that aren't in a project with repositories. */
    defaultRepositoryId: uuid('default_repository_id').references(
      (): AnyPgColumn => repositories.id,
      { onDelete: 'set null' },
    ),
    gitAutomation: jsonb('git_automation').$type<GitAutomation>().notNull().default({}),
    autoArchiveMonths: integer('auto_archive_months'),
    slaHours: jsonb('sla_hours').$type<SlaHours>().notNull().default({}),
    /** Partial; missing settings use DEFAULT_CYCLE_AUTOMATION. */
    cycleAutomation: jsonb('cycle_automation')
      .$type<Partial<CycleAutomation>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('teams_workspace_key_idx').on(t.workspaceId, t.key)],
);

/** Rules that sort what lands in a team's triage. */
export const triageRules = pgTable(
  'triage_rules',
  {
    id: pk(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    position: doublePrecision('position').notNull().default(0),
    conditions: jsonb('conditions').$type<TriageConditions>().notNull().default({}),
    actions: jsonb('actions').$type<TriageActions>().notNull().default({}),
    /** Whose turn it is in a rotation. */
    turn: integer('turn').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('triage_rules_team_idx').on(t.teamId)],
);

/** Former team keys, so identifiers in old branches, commits and links keep resolving. */
export const teamKeyAliases = pgTable(
  'team_key_aliases',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
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

/**
 * Starting points for new issues: a name, a title and description, and default properties.
 * Team templates may set a status; references to deleted things fall away.
 */
export const issueTemplates = pgTable(
  'issue_templates',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    stateId: uuid('state_id').references(() => workflowStates.id, { onDelete: 'set null' }),
    priority: integer('priority'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    estimate: integer('estimate'),
    labelIds: uuid('label_ids').array().notNull().default(sql`'{}'`),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('issue_templates_workspace_idx').on(t.workspaceId)],
);

export const customers = pgTable(
  'customers',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domains: text('domains').array().notNull().default(sql`'{}'`),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('customers_workspace_idx').on(t.workspaceId)],
);

/** A customer asking for an issue: what they said, who said it, where it came from. */
export const customerRequests = pgTable(
  'customer_requests',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references((): AnyPgColumn => issues.id, { onDelete: 'cascade' }),
    body: text('body').notNull().default(''),
    contact: text('contact'),
    source: text('source').$type<'manual' | 'email' | 'api'>().notNull().default('manual'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('customer_requests_issue_idx').on(t.issueId),
    index('customer_requests_customer_idx').on(t.customerId),
  ],
);

/** Workspace-level goals; each project belongs to at most one. */
export const initiatives = pgTable(
  'initiatives',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<InitiativeStatus>().notNull().default('planned'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    targetDate: date('target_date', { mode: 'string' }),
    color: text('color').notNull().default('#ff1493'),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('initiatives_workspace_idx').on(t.workspaceId)],
);

/** Schedules that turn a template into a new issue every so often. */
export const recurringIssues = pgTable(
  'recurring_issues',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => issueTemplates.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    every: integer('every').notNull(),
    unit: text('unit').$type<RecurrenceUnit>().notNull(),
    nextOn: date('next_on', { mode: 'string' }).notNull(),
    paused: boolean('paused').notNull().default(false),
    lastIssueId: uuid('last_issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'set null',
    }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('recurring_issues_next_idx').on(t.nextOn)],
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
    initiativeId: uuid('initiative_id').references(() => initiatives.id, { onDelete: 'set null' }),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    /** Who new issues in the project go to: the workspace's default, nobody, or `defaultAssigneeId`. */
    defaultAssigneeMode: text('default_assignee_mode')
      .$type<'workspace' | 'none' | 'member'>()
      .notNull()
      .default('workspace'),
    defaultAssigneeId: uuid('default_assignee_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The agent that gets the project's pull requests once they're ready for review. */
    pullRequestAgentId: uuid('pull_request_agent_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Which: PRs linked to the project's issues, or every PR in its repositories. */
    pullRequestScope: text('pull_request_scope')
      .$type<PullRequestScope>()
      .notNull()
      .default('linked'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_workspace_idx').on(t.workspaceId)],
);

export const projectDocuments = pgTable(
  'project_documents',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('project_documents_project_idx').on(t.projectId)],
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

/** Stages of a project, each with an optional target date; issues of the project can belong to one. */
export const projectMilestones = pgTable(
  'project_milestones',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    targetDate: date('target_date', { mode: 'string' }),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('project_milestones_project_idx').on(t.projectId)],
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
    /** Set once cycle automation has handled the end of the cycle (rolled its open issues over). */
    completedAt: ts('completed_at'),
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
    milestoneId: uuid('milestone_id').references(() => projectMilestones.id, {
      onDelete: 'set null',
    }),
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
    slaBreachesAt: ts('sla_breaches_at'),
    /** Set once the breach was announced, so it's announced once. */
    slaNotifiedAt: ts('sla_notified_at'),
    archivedAt: ts('archived_at'),
  },
  (t) => [
    uniqueIndex('issues_team_number_idx').on(t.teamId, t.number),
    index('issues_workspace_idx').on(t.workspaceId),
    index('issues_state_idx').on(t.stateId),
    index('issues_assignee_idx').on(t.assigneeId),
    index('issues_project_idx').on(t.projectId),
    index('issues_cycle_idx').on(t.cycleId),
    index('issues_parent_idx').on(t.parentId),
    // Full-text search; the expression must stay identical to issueDocument in services/search.ts.
    index('issues_search_idx').using(
      'gin',
      sql`(setweight(to_tsvector('simple', ${t.title}), 'A') || setweight(to_tsvector('simple', ${t.description}), 'B'))`,
    ),
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
  (t) => [
    index('comments_issue_idx').on(t.issueId),
    // Full-text search; the expression must stay identical to commentDocument in services/search.ts.
    index('comments_search_idx').using('gin', sql`to_tsvector('simple', ${t.body})`),
  ],
);

export const commentReactions = pgTable(
  'comment_reactions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId, t.emoji] })],
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
    /** Hidden from the inbox until then. */
    snoozedUntil: ts('snoozed_until'),
    /** When a snooze ended: the inbox sorts by this, or by creation. */
    wokeAt: ts('woke_at'),
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

/** Keys the instance makes for itself (the VAPID key pair for web push), encrypted. */
export const instanceKeys = pgTable('instance_keys', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: createdAt(),
});

/** A browser (or installed app) that wants this person's notifications pushed to it. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

/**
 * Apps that sign in to the MCP server with OAuth. Registered on the fly (RFC 7591), or known by
 * the metadata document their client_id points at, kept here as a cache.
 */
export const oauthClients = pgTable('oauth_clients', {
  id: pk(),
  /** What the app sends as client_id: a random id, or its metadata document's URL. */
  clientId: text('client_id').notNull().unique(),
  secretHash: text('secret_hash'),
  authMethod: text('auth_method')
    .$type<'none' | 'client_secret_post' | 'client_secret_basic'>()
    .notNull(),
  name: text('name').notNull(),
  uri: text('uri'),
  redirectUris: text('redirect_uris').array().notNull(),
  /** When the metadata document was last read; null for registered clients. */
  fetchedAt: ts('fetched_at'),
  /** Last time someone connected it; registrations nobody ever finished are pruned. */
  lastUsedAt: ts('last_used_at'),
  createdAt: createdAt(),
});

/** Authorization codes waiting to be exchanged; single use, minutes long. */
export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  /** The SSO login the consent was given in, carried into the grant for require-SSO. */
  ssoProviderId: uuid('sso_provider_id'),
  ssoExpiresAt: ts('sso_expires_at'),
  expiresAt: ts('expires_at').notNull(),
});

/** One person's permission for one app to use one workspace's MCP server. */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: pk(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ssoProviderId: uuid('sso_provider_id'),
    ssoExpiresAt: ts('sso_expires_at'),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('oauth_grants_user_idx').on(t.userId)],
);

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: pk(),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'access' | 'refresh'>().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    /** Refresh tokens work once; one coming back after that has leaked, and ends the grant. */
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('oauth_tokens_grant_idx').on(t.grantId)],
);

/** One-time tokens sent by email (password reset, email verification/change) or used between login steps (MFA). */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<
        | 'password_reset'
        | 'email_verify'
        | 'email_change'
        | 'mfa'
        | 'integration_setup'
        | 'chat_link'
      >()
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

/** WebAuthn credentials (passkeys): sign-in without a password, or a second factor after one. */
export const passkeys = pgTable(
  'passkeys',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The credential id, base64url. */
    credentialId: text('credential_id').notNull().unique(),
    /** COSE public key, base64url. */
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
    /** Synced across devices (iCloud Keychain, Google Password Manager…) rather than bound to one. */
    backedUp: boolean('backed_up').notNull().default(false),
    name: text('name').notNull(),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

/**
 * One WebAuthn ceremony's challenge, used once. `userId` is null for passwordless sign-in, where
 * who it is comes from the passkey itself.
 */
export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: text('id').primaryKey(),
  challenge: text('challenge').notNull(),
  purpose: text('purpose').$type<'register' | 'login' | 'mfa'>().notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
});

/** Uploaded files. The bytes live in the storage backend under `storage_key`. */
export const files = pgTable(
  'files',
  {
    id: pk(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').$type<'avatar' | 'logo' | 'attachment' | 'import' | 'export'>().notNull(),
    storageKey: text('storage_key').notNull().unique(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('files_workspace_idx').on(t.workspaceId)],
);

/**
 * Files attached to issues. `issue_id` stays null from upload until a description or comment that
 * references the file is saved; unclaimed uploads are swept after a day.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .unique()
      .references(() => files.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_issue_idx').on(t.issueId)],
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
    protocol: text('protocol').$type<'oidc' | 'saml'>().notNull().default('oidc'),
    /** OpenID Connect only. */
    issuer: text('issuer'),
    clientId: text('client_id'),
    /** Encrypted (aad auth_providers:<id>:client_secret). OpenID Connect only. */
    clientSecret: text('client_secret'),
    scopes: text('scopes').notNull().default('openid email profile'),
    /** SAML only: the identity provider's entity ID, sign-in URL and signing certificates. */
    saml: jsonb('saml').$type<SamlSettings>(),
    /**
     * SAML has no "email verified": the admin vouches for the IdP's emails here. Even then they're
     * trusted only on the workspace's verified domains.
     */
    trustEmail: boolean('trust_email').notNull().default(false),
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
  /** OpenID Connect. */
  nonce: text('nonce'),
  codeVerifier: text('code_verifier'),
  /** SAML: the AuthnRequest's ID, which the response must answer. */
  requestId: text('request_id'),
  /** SAML: what the validated response said, kept until the browser comes back with its cookie. */
  claims: jsonb('claims').$type<Record<string, unknown>>(),
  /** login | link (attach to `userId`) | test (show claims to an admin). */
  mode: text('mode').$type<'login' | 'link' | 'test'>().notNull().default('login'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  redirect: text('redirect'),
  expiresAt: ts('expires_at').notNull(),
});

// ─── Sync (offline-first clients) ──────────────────────────────────────

/**
 * Each workspace's position in its change log. `seq` counts changes, in commit order; a new
 * `epoch` tells clients to load everything again (imports, deleted teams); changes up to
 * `min_seq` have been pruned.
 */
export const syncCursors = pgTable('sync_cursors', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
  epoch: integer('epoch').notNull().default(1),
  minSeq: bigint('min_seq', { mode: 'number' }).notNull().default(0),
});

/**
 * What changed, not how: clients fetch the current rows through access-scoped loaders, so the log
 * holds no data anyone could read without being allowed to.
 */
export const syncChanges = pgTable(
  'sync_changes',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').$type<'created' | 'updated' | 'deleted'>().notNull(),
    /** The teams the entity belongs (and belonged) to; empty for workspace-wide things. */
    teamIds: uuid('team_ids').array().notNull().default([]),
    /** Set for changes only one person may see (their notifications). */
    userId: uuid('user_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.seq] }),
    index('sync_changes_created_idx').on(t.createdAt),
  ],
);

// ─── SCIM (directory sync) ──────────────────────────────────────────────

/** Bearer tokens an identity provider uses to provision one workspace over SCIM. */
export const scimTokens = pgTable(
  'scim_tokens',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('scim_tokens_workspace_idx').on(t.workspaceId)],
);

/** Groups the directory pushes; one linked to a team decides who is on it. */
export const scimGroups = pgTable(
  'scim_groups',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    externalId: text('external_id'),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('scim_groups_workspace_idx').on(t.workspaceId),
    index('scim_groups_team_idx').on(t.teamId),
  ],
);

export const scimGroupMembers = pgTable(
  'scim_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => scimGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/** Members the workspace's directory manages, with the directory's own id for them. */
export const scimUsers = pgTable(
  'scim_users',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('scim_users_member_idx').on(t.workspaceId, t.userId),
    index('scim_users_external_idx').on(t.workspaceId, t.externalId),
  ],
);

// ─── Events, webhooks, integrations ──────────────────────────────────────

/**
 * The outbox: domain events written in the same transaction as the change they describe, then
 * fanned out to webhooks and integrations by an `events.dispatch` job.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').$type<DomainEventType>().notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    /** Teams the event belongs to; deliveries respect team filters and private teams by these. */
    teamIds: uuid('team_ids').array().notNull().default(sql`'{}'`),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    changes: jsonb('changes').$type<HistoryChange[]>(),
    createdAt: createdAt(),
  },
  (t) => [index('domain_events_workspace_idx').on(t.workspaceId, t.id)],
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    /** Encrypted signing secret. */
    secret: text('secret').notNull(),
    eventTypes: text('event_types').array().$type<DomainEventType[]>().notNull().default(sql`'{}'`),
    teamIds: uuid('team_ids').array().notNull().default(sql`'{}'`),
    enabled: boolean('enabled').notNull().default(true),
    failureCount: integer('failure_count').notNull().default(0),
    disabledReason: text('disabled_reason'),
    lastDeliveryAt: ts('last_delivery_at'),
    lastStatus: integer('last_status'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('webhooks_workspace_idx').on(t.workspaceId)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: pk(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    /** Null for pings. Not a foreign key: events are pruned before deliveries. */
    eventId: bigint('event_id', { mode: 'number' }),
    eventType: text('event_type').notNull(),
    /** The exact body sent, so redeliveries match the original. */
    payload: jsonb('payload').$type<WebhookPayload>().notNull(),
    status: text('status').$type<'pending' | 'success' | 'failed'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt)],
);

/** Instance-level app credentials shared by many workspaces (a GitHub App, a Slack app, a Discord bot…). */
export const integrationApps = pgTable(
  'integration_apps',
  {
    id: pk(),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Encrypted JSON object of secrets. */
    secrets: text('secrets'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('integration_apps_provider_idx').on(t.provider)],
);

/** One connection between a workspace and an outside service. */
export const integrations = pgTable(
  'integrations',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    appId: uuid('app_id').references(() => integrationApps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Encrypted JSON object of secrets (tokens, signing secrets). */
    secrets: text('secrets'),
    /** The bot account changes are attributed to. */
    botUserId: uuid('bot_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Random path segment of this integration's inbound webhook URL. */
    inboundToken: text('inbound_token').notNull().unique(),
    /** Provider-specific id of the remote installation, e.g. a GitHub installation id. */
    externalId: text('external_id'),
    status: text('status').$type<'active' | 'error' | 'disabled'>().notNull().default('active'),
    lastError: text('last_error'),
    lastEventAt: ts('last_event_at'),
    /** Polling cursor and other provider state. */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    lastPolledAt: ts('last_polled_at'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('integrations_workspace_idx').on(t.workspaceId),
    index('integrations_external_idx').on(t.provider, t.externalId),
  ],
);

export const issueLinks = pgTable(
  'issue_links',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    kind: text('kind').$type<IssueLinkKind>().notNull(),
    /** Stable id at the provider (PR node id, commit sha, message ts…); the URL for plain links. */
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    state: text('state'),
    author: text('author'),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('issue_links_external_idx').on(t.issueId, t.provider, t.kind, t.externalId),
    index('issue_links_lookup_idx').on(t.workspaceId, t.provider, t.externalId),
  ],
);

/**
 * Chat messages that belong to an issue's thread in a channel: the card that started it (`root`),
 * what Ordo posted into it and the replies it turned into comments. Replies are matched to an
 * issue through these, and nothing is synced twice.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: pk(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** The service's id for the message: Slack ts, Discord or Telegram message id, Matrix event id. */
    messageRef: text('message_ref').notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'set null' }),
    root: boolean('root').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('chat_messages_ref_idx').on(t.integrationId, t.channel, t.messageRef),
    index('chat_messages_issue_idx').on(t.integrationId, t.channel, t.issueId),
  ],
);

/**
 * A Matrix integration's end-to-end encryption keys (its device's Olm account, sessions and room
 * keys): a snapshot of the crypto store, encrypted with the instance key. `version` goes up with
 * every change, so a server holding an older copy in memory knows to reload it.
 */
export const matrixCryptoStores = pgTable('matrix_crypto_stores', {
  integrationId: uuid('integration_id')
    .primaryKey()
    .references(() => integrations.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(0),
  data: text('data').notNull(),
  updatedAt: updatedAt(),
});

/**
 * A workspace's own AI model, used instead of the instance's when the workspace chooses it
 * (`settings.aiSource = 'workspace'`). Kept apart from `workspaces.settings`, which every member
 * receives, because of the key.
 */
export const workspaceAiProviders = pgTable('workspace_ai_providers', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<'anthropic' | 'openai'>().notNull(),
  model: text('model').notNull(),
  /** OpenAI-compatible endpoints only; the Claude API is always api.anthropic.com here. */
  baseUrl: text('base_url'),
  /** Encrypted with the instance key. */
  apiKey: text('api_key'),
  updatedAt: updatedAt(),
});

/**
 * What an integration keeps in sync: one of its remote objects (a Jira issue, a Jira comment) and
 * the Ordo row it's paired with. `data` holds the remote values as of the last sync, so only real
 * changes travel, in either direction, and nothing echoes back and forth.
 */
export const integrationRefs = pgTable(
  'integration_refs',
  {
    id: pk(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'issue' | 'comment'>().notNull(),
    externalId: text('external_id').notNull(),
    localId: uuid('local_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('integration_refs_external_idx').on(t.integrationId, t.kind, t.externalId),
    uniqueIndex('integration_refs_local_idx').on(t.integrationId, t.kind, t.localId),
  ],
);

/** An account at an outside service (GitHub login, Slack user…) mapped to an Ordo user. */
export const externalAccounts = pgTable(
  'external_accounts',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** Distinguishes several servers of one provider (e.g. two GitLab instances); empty for SaaS. */
    host: text('host').notNull().default(''),
    externalId: text('external_id').notNull(),
    username: text('username'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Chat accounts belong to one integration and are proven by a link code sent from them, so
     * Ordo may message them privately. Forge usernames are claimed, never verified (null).
     */
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'cascade',
    }),
    verifiedAt: ts('verified_at'),
    /** Chat: whether to send personal notifications, and the direct-message channel once known. */
    data: jsonb('data').$type<{ notify?: boolean; dmChannel?: string }>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('external_accounts_idx').on(t.workspaceId, t.provider, t.host, t.externalId),
    index('external_accounts_user_idx').on(t.userId),
  ],
);

/**
 * An import from another tracker or a file: analyzed, mapped, dry-run, then run by jobs in
 * batches. `cursor` is where the run got to, so a retried or resumed job carries on from there.
 */
export const imports = pgTable(
  'imports',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source').$type<ImportSource>().notNull(),
    name: text('name').notNull(),
    status: text('status').$type<ImportStatus>().notNull().default('analyzing'),
    /** Source settings, e.g. which CSV column feeds which field. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Encrypted JSON of credentials for API sources. */
    secrets: text('secrets'),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    summary: jsonb('summary').$type<ImportSummary>(),
    mapping: jsonb('mapping').$type<ImportMapping>(),
    report: jsonb('report').$type<ImportReport>(),
    progress: jsonb('progress').$type<ImportProgress>(),
    cursor: jsonb('cursor').$type<Record<string, unknown>>(),
    error: text('error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [index('imports_workspace_idx').on(t.workspaceId)],
);

/** What an import created, by source id: lets retries skip what's done and undo find it. */
export const importItems = pgTable(
  'import_items',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<'team' | 'user' | 'label' | 'project' | 'cycle' | 'issue' | 'comment' | 'relation'>()
      .notNull(),
    externalId: text('external_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.importId, t.kind, t.externalId] })],
);

/** A workspace export: a job writes the file, which is kept for a week. */
export const workspaceExports = pgTable(
  'workspace_exports',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    format: text('format').$type<ExportFormat>().notNull(),
    status: text('status').$type<'running' | 'ready' | 'failed'>().notNull().default('running'),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    size: integer('size'),
    error: text('error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [index('workspace_exports_workspace_idx').on(t.workspaceId)],
);

/** A git repository work happens in. Only where it is: runners bring their own credentials. */
export const repositories = pgTable(
  'repositories',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    /** The forge integration and its repo ("owner/name") that pull requests come from. */
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'set null',
    }),
    externalRepo: text('external_repo'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('repositories_workspace_idx').on(t.workspaceId)],
);

export const projectRepositories = pgTable(
  'project_repositories',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.repositoryId] }),
    index('project_repositories_repository_idx').on(t.repositoryId),
  ],
);

/** What makes a `kind: 'agent'` user an agent: its settings. The user row is its identity. */
export const agents = pgTable('agents', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Markdown added to every run's prompt. */
  instructions: text('instructions').notNull().default(''),
  /** Runs it works on at once, across its runners. */
  concurrency: integer('concurrency').notNull().default(1),
  /** Whether failing checks and requested changes on its issues' pull requests give it a run. */
  followPullRequests: boolean('follow_pull_requests').notNull().default(true),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One pickup of an issue by an agent. Runners claim queued runs with a lease they keep alive by
 * heartbeat; a lapsed lease puts the run back in the queue (see services/agents.ts).
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: pk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.userId, { onDelete: 'cascade' }),
    status: text('status').$type<AgentRunStatus>().notNull().default('queued'),
    /** Claims so far; each lapsed lease counts. */
    attempts: integer('attempts').notNull().default(0),
    leaseExpiresAt: ts('lease_expires_at'),
    runnerName: text('runner_name'),
    sessionUrl: text('session_url'),
    summary: text('summary'),
    error: text('error'),
    /** Why it was queued: assignment, a person's @mention, or Run again. */
    trigger: text('trigger').$type<AgentRunTrigger>().notNull().default('assigned'),
    triggerCommentId: uuid('trigger_comment_id').references(() => comments.id, {
      onDelete: 'set null',
    }),
    /** For a `pull_request` run: which pull request and what happened to it. */
    triggerDetail: jsonb('trigger_detail').$type<AgentRunPullRequest>(),
    /** The agent's last question; set while `waiting`, kept after it resumes. */
    question: text('question'),
    /** Opaque to Ordo: the runner's handle on the agent's session, returned on the next pickup. */
    resume: text('resume'),
    requestedById: uuid('requested_by_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('agent_runs_agent_status_idx').on(t.agentId, t.status, t.createdAt),
    index('agent_runs_issue_idx').on(t.issueId),
    index('agent_runs_lease_idx').on(t.leaseExpiresAt),
  ],
);
