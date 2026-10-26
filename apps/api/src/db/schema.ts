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
  UserKind,
} from '@ordo/shared';
import { sql } from 'drizzle-orm';
import {
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
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
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
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
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
