import type {
  AuditAction,
  EstimateScale,
  FavoriteKind,
  MemberRole,
  NotificationType,
  ProjectHealth,
  ProjectStatus,
  StateType,
  TeamRole,
} from './constants.ts';
import type { IssueDisplay, IssueFilter } from './schemas.ts';

/** API response shapes. Dates are ISO strings on the wire. */

export interface User {
  id: string;
  name: string;
  username: string;
  email: string;
  avatarColor: string;
  /** Signed URL of the uploaded avatar, or null to show initials. */
  avatarUrl: string | null;
}

export interface Me extends User {
  isInstanceAdmin: boolean;
  workspaces: { id: string; name: string; slug: string; role: MemberRole }[];
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  defaultTeamId: string | null;
  settings: WorkspaceSettings;
  createdAt: string;
}

export interface Member extends User {
  role: MemberRole;
  joinedAt: string;
  suspended: boolean;
}

export interface WorkflowState {
  id: string;
  teamId: string;
  name: string;
  type: StateType;
  color: string;
  position: number;
  description: string | null;
}

export interface Team {
  id: string;
  name: string;
  key: string;
  description: string | null;
  color: string;
  estimateScale: EstimateScale;
  triageEnabled: boolean;
  cyclesEnabled: boolean;
  defaultStateId: string | null;
  /** Private teams are visible only to their members and workspace admins. */
  private: boolean;
  memberIds: string[];
  members: { userId: string; role: TeamRole }[];
  states: WorkflowState[];
}

export interface Label {
  id: string;
  teamId: string | null;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  color: string;
  status: ProjectStatus;
  leadId: string | null;
  startDate: string | null;
  targetDate: string | null;
  teamIds: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  progress: Progress;
  health: ProjectHealth | null;
}

export interface Progress {
  total: number;
  completed: number;
  started: number;
  canceled: number;
  totalEstimate: number;
  completedEstimate: number;
}

export interface ProjectUpdate {
  id: string;
  projectId: string;
  authorId: string | null;
  body: string;
  health: ProjectHealth;
  createdAt: string;
}

export interface Cycle {
  id: string;
  teamId: string;
  number: number;
  name: string | null;
  description: string | null;
  startsAt: string;
  endsAt: string;
  progress: Progress;
}

export interface Issue {
  id: string;
  identifier: string;
  number: number;
  teamId: string;
  title: string;
  description: string;
  stateId: string;
  priority: number;
  assigneeId: string | null;
  /** Null when the creator's account was deleted. */
  creatorId: string | null;
  projectId: string | null;
  cycleId: string | null;
  parentId: string | null;
  estimate: number | null;
  dueDate: string | null;
  sortOrder: number;
  labelIds: string[];
  subIssueCount: number;
  completedSubIssueCount: number;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** A relation as seen from one issue; stored relations are mirrored for the other side. */
export type RelationView = 'blocks' | 'blocked_by' | 'related' | 'duplicate_of' | 'duplicated_by';

export interface IssueRelation {
  id: string;
  type: RelationView;
  issue: IssueRef;
}

export interface IssueRef {
  id: string;
  identifier: string;
  title: string;
  stateId: string;
  teamId: string;
}

export interface IssueDetail extends Issue {
  parent: IssueRef | null;
  subIssues: Issue[];
  relations: IssueRelation[];
  subscriberIds: string[];
}

export interface Comment {
  id: string;
  issueId: string;
  /** Null when the author's account was deleted. */
  authorId: string | null;
  parentId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
}

export interface HistoryChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface HistoryEntry {
  id: string;
  issueId: string;
  actorId: string | null;
  changes: HistoryChange[];
  createdAt: string;
}

export interface Notification {
  id: string;
  type: NotificationType;
  issueId: string | null;
  commentId: string | null;
  actorId: string | null;
  readAt: string | null;
  createdAt: string;
  issue: IssueRef | null;
  data: Record<string, unknown>;
}

export interface View {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  teamId: string | null;
  shared: boolean;
  filters: IssueFilter;
  display: IssueDisplay;
  createdAt: string;
  updatedAt: string;
}

export interface Favorite {
  id: string;
  kind: FavoriteKind;
  targetId: string;
  sortOrder: number;
}

export interface Invite {
  id: string;
  token: string;
  email: string | null;
  role: MemberRole;
  teamIds: string[];
  expiresAt: string;
  createdAt: string;
  lastSentAt: string | null;
  url: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Everything small enough to load once per workspace; issues load per view. */
export interface Bootstrap {
  workspace: Workspace;
  role: MemberRole;
  members: Member[];
  teams: Team[];
  labels: Label[];
  projects: Project[];
  cycles: Cycle[];
  views: View[];
  favorites: Favorite[];
  unreadCount: number;
}

export interface InstanceConfig {
  signupMode: 'open' | 'invite';
  hasUsers: boolean;
  /** Whether SMTP is configured, i.e. password resets and email invites work. */
  emailEnabled: boolean;
  allowWorkspaceCreation: boolean;
  version: string;
}

export interface SearchResults {
  issues: Issue[];
  projects: { id: string; name: string; color: string }[];
}

export interface AuditEntry {
  id: string;
  workspaceId: string | null;
  actorId: string | null;
  action: AuditAction;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** Instance-wide settings (admin area). Environment variables override stored values. */
export interface InstanceSettings {
  signupMode: 'open' | 'invite';
  allowWorkspaceCreation: boolean;
  /** Let outbound requests (IdP discovery, webhooks, forge URLs) reach private/LAN addresses. */
  allowPrivateNetworkTargets: boolean;
  /**
   * Outgoing mail. `url` is smtp(s)://user:password@host:port; stored encrypted. Null disables email.
   */
  smtp: { url: string; from: string } | null;
}

export const INSTANCE_SETTING_DEFAULTS: InstanceSettings = {
  signupMode: 'invite',
  allowWorkspaceCreation: true,
  allowPrivateNetworkTargets: false,
  smtp: null,
};

export interface InstanceSettingEntry<K extends keyof InstanceSettings = keyof InstanceSettings> {
  key: K;
  value: InstanceSettings[K];
  /** Where the effective value comes from; `env` values are read-only in the UI. */
  source: 'env' | 'db' | 'default';
}

export type EmailDigest = 'off' | 'instant' | 'hourly' | 'daily';

/** Per-user preferences. Missing keys fall back to DEFAULT_PREFERENCES. */
export interface UserPreferences {
  /** IANA zone, e.g. "Europe/Stockholm"; null follows the browser. */
  timezone: string | null;
  /** 0 = Sunday, 1 = Monday. */
  weekStartsOn: 0 | 1;
  notifications: {
    /** How notification emails are batched; "off" sends none. */
    emailDigest: EmailDigest;
    /** Notification types that may be emailed. */
    email: Record<NotificationType, boolean>;
  };
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  timezone: null,
  weekStartsOn: 1,
  notifications: {
    emailDigest: 'instant',
    email: {
      issue_assigned: true,
      issue_unassigned: false,
      issue_comment: true,
      issue_mention: true,
      issue_status_changed: false,
      issue_priority_urgent: true,
    },
  },
};

export interface Account extends Me {
  emailVerified: boolean;
  hasPassword: boolean;
  twoFactorEnabled: boolean;
  avatarUrl: string | null;
  preferences: UserPreferences;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  sso: boolean;
}

/** Organisation-level policy, editable by workspace admins. */
export interface WorkspaceSettings {
  /** Who may create invites: admins only, or members too (members can't invite admins). */
  invitePolicy: 'admins' | 'members';
  /** People with a verified email at a verified domain may join without an invite. */
  domainAutoJoin: boolean;
  /** Role given to people joining through a verified domain. */
  autoJoinRole: 'member' | 'guest';
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  invitePolicy: 'admins',
  domainAutoJoin: false,
  autoJoinRole: 'member',
};

export interface WorkspaceDomain {
  id: string;
  domain: string;
  verificationToken: string;
  verified: boolean;
  verifiedBy: 'dns' | 'instance_admin' | null;
  createdAt: string;
}

export interface JoinableWorkspace {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  memberCount: number;
}
