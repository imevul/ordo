import type {
  AuditAction,
  ChatEventKind,
  DomainEventType,
  EstimateScale,
  FavoriteKind,
  InitiativeStatus,
  IssueLinkKind,
  Locale,
  MemberRole,
  NotificationType,
  Priority,
  ProjectHealth,
  ProjectStatus,
  RecurrenceUnit,
  StateType,
  TeamRole,
  UserKind,
} from './constants.ts';
import { DEFAULT_LOCALE } from './constants.ts';
import { DEFAULT_BRANCH_FORMAT, type GitAutomation } from './git.ts';
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
  /** The language the app, emails and notifications use for this person. */
  locale: Locale;
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

/** An integration's account. `removed`: its integration was disconnected; only its history remains. */
export interface Bot extends User {
  removed: boolean;
}

/** A placeholder as admins see it, with what's attributed to it and who it probably is. */
export interface PlaceholderSummary {
  id: string;
  name: string;
  avatarColor: string;
  /** The email the import's source had for them. */
  importedEmail: string | null;
  assigned: number;
  created: number;
  comments: number;
  /** A member with the same email or name, if there is one. */
  suggestedUserId: string | null;
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
  /** Where linked pull requests move issues; missing events use `defaultGitAutomation`. */
  gitAutomation: GitAutomation;
  cycleAutomation: CycleAutomation;
  /** Closed issues are archived this many months after they closed; null never. */
  autoArchiveMonths: number | null;
  /** Hours to resolve an issue, by priority ("1" urgent … "4" low); missing means no SLA. */
  slaHours: SlaHours;
  /** Applied in order to issues created in triage. */
  triageRules: TriageRule[];
  memberIds: string[];
  members: { userId: string; role: TeamRole }[];
  /** Directory groups (SCIM) that decide who is on the team; empty when people join by hand. */
  managedBy: string[];
  states: WorkflowState[];
}

export const TRIAGE_SOURCES = ['web', 'api', 'mcp', 'integration', 'email'] as const;
export type TriageSource = (typeof TRIAGE_SOURCES)[number];

/** What an incoming triage issue must match; empty matches everything. All given parts must hold. */
export interface TriageConditions {
  /** Where it came from (any of). */
  sources?: TriageSource[];
  /** Text in its title or description (case-insensitive). */
  text?: string;
  labelIds?: string[];
  priorities?: number[];
}

/** What a matching rule does. */
export interface TriageActions {
  priority?: number;
  /** Added to the issue's labels. */
  labelIds?: string[];
  assigneeId?: string;
  /** Assign in turn to these people, round-robin (instead of `assigneeId`). */
  rotation?: string[];
  /** Accept the issue into this (non-triage) status. */
  stateId?: string;
}

export interface TriageRule {
  id: string;
  teamId: string;
  name: string;
  enabled: boolean;
  position: number;
  conditions: TriageConditions;
  actions: TriageActions;
}

export type SlaHours = Partial<Record<'1' | '2' | '3' | '4', number>>;

/** Cycles that run themselves: created ahead of time, with unfinished work carried over. */
export interface CycleAutomation {
  enabled: boolean;
  /** Cycle length. */
  weeks: number;
  /** Weeks off between cycles. */
  cooldownWeeks: number;
  /** Weekday cycles start on, 0 = Sunday … 6 = Saturday. */
  startDay: number;
  /** How many cycles to keep planned after the current one. */
  upcoming: number;
  /** Move unfinished issues to the next cycle when one ends. */
  rollOver: boolean;
  /** Put issues into the active cycle when work on them starts. */
  addStarted: boolean;
}

export const DEFAULT_CYCLE_AUTOMATION: CycleAutomation = {
  enabled: false,
  weeks: 2,
  cooldownWeeks: 0,
  startDay: 1,
  upcoming: 2,
  rollOver: true,
  addStarted: false,
};

/** Stored settings are partial; this fills in the defaults. */
export const cycleAutomationOf = (stored?: Partial<CycleAutomation> | null): CycleAutomation => ({
  ...DEFAULT_CYCLE_AUTOMATION,
  ...stored,
});

export interface Label {
  id: string;
  teamId: string | null;
  name: string;
  color: string;
}

export interface IssueTemplate {
  id: string;
  /** Null for templates every team can use. */
  teamId: string | null;
  name: string;
  title: string;
  description: string;
  /** Only on team templates. */
  stateId: string | null;
  priority: number | null;
  assigneeId: string | null;
  projectId: string | null;
  estimate: number | null;
  labelIds: string[];
  createdById: string | null;
  updatedAt: string;
}

/** A template that becomes a new issue on a schedule. */
export interface RecurringIssue {
  id: string;
  templateId: string;
  teamId: string;
  every: number;
  unit: RecurrenceUnit;
  /** The next day an issue is created (UTC). */
  nextOn: string;
  paused: boolean;
  lastIssueId: string | null;
  createdById: string | null;
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
  /** In order: by target date, then as arranged. */
  milestones: Milestone[];
  initiativeId: string | null;
}

/** An organisation that asks for things; requests tie what they asked to issues. */
export interface Customer {
  id: string;
  name: string;
  /** Email domains that identify its people ("acme.com"), lower case. */
  domains: string[];
  ownerId: string | null;
  notes: string | null;
  /** Requests on issues the viewer can see, and how many of those issues are still open. */
  requestCount: number;
  openIssueCount: number;
  createdAt: string;
}

export interface CustomerRequest {
  id: string;
  customerId: string;
  issueId: string;
  /** What they said, quoted. */
  body: string;
  /** Who asked: "Ada Lovelace <ada@acme.com>". */
  contact: string | null;
  source: 'manual' | 'email' | 'api';
  createdById: string | null;
  createdAt: string;
}

/** A request as listed on its customer: with the issue it's about. */
export interface CustomerRequestWithIssue extends CustomerRequest {
  issue: { id: string; identifier: string; title: string; stateId: string; teamId: string };
}

/** A document in a project: specs, notes, decisions. */
export interface ProjectDocument {
  id: string;
  projectId: string;
  title: string;
  /** Markdown; left out of lists. */
  content?: string;
  createdById: string | null;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A workspace-level goal that groups projects. */
export interface Initiative {
  id: string;
  name: string;
  description: string | null;
  status: InitiativeStatus;
  ownerId: string | null;
  targetDate: string | null;
  color: string;
  sortOrder: number;
  /** Its projects the viewer can see. */
  projectIds: string[];
  /** Summed over those projects. */
  progress: Progress;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  sortOrder: number;
  progress: Progress;
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
  /** A milestone of the issue's project. */
  milestoneId: string | null;
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
  /** Archived issues are out of lists and boards, but still open by link and in search. */
  /** When the team's SLA for this priority runs out; null without one. */
  slaBreachesAt: string | null;
  archivedAt: string | null;
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
  links: IssueLink[];
  attachments: Attachment[];
  /** Empty for guests. */
  customerRequests: CustomerRequest[];
}

/** A file uploaded to an issue (or, until a description or comment uses it, to its uploader). */
export interface Attachment {
  id: string;
  /** Null between upload and the issue description or comment that references it. */
  issueId: string | null;
  filename: string;
  /** Sniffed from the bytes: an image type, or `application/octet-stream` for everything else. */
  contentType: string;
  size: number;
  /** Stable URL; needs a session or API key that can read the issue. */
  url: string;
  uploaderId: string | null;
  createdAt: string;
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
  /** In the order each emoji was first used. */
  reactions: CommentReaction[];
}

export interface CommentReaction {
  emoji: string;
  userIds: string[];
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
  /** Hidden from the inbox until then. */
  snoozedUntil: string | null;
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

/** An app as the consent screen and the connected-apps list show it. */
export interface OAuthClientInfo {
  name: string;
  /** The host the app is known by: its metadata document's, else where it sends people back to. */
  host: string;
  /** The name comes from a document on the app's own domain, not from what the app claimed. */
  verified: boolean;
}

/** An app allowed to use a workspace's MCP server as this person. */
export interface OAuthGrant {
  id: string;
  client: OAuthClientInfo;
  workspace: { name: string; slug: string };
  lastUsedAt: string | null;
  createdAt: string;
}

/** What the consent screen shows about a valid authorization request. */
export interface OAuthAuthorizeInfo {
  client: OAuthClientInfo;
  workspace: { name: string; slug: string };
  redirectUri: string;
}

/** Everything small enough to load once per workspace; issues load per view. */
export interface Bootstrap {
  workspace: Workspace;
  role: MemberRole;
  members: Member[];
  /** Integration accounts: not members, but they appear as authors of what integrations do. */
  bots: Bot[];
  /** People from imports who aren't members (yet): shown on what they did and were assigned. */
  placeholders: User[];
  teams: Team[];
  labels: Label[];
  templates: IssueTemplate[];
  recurring: RecurringIssue[];
  /** Empty for guests. */
  customers: Customer[];
  initiatives: Initiative[];
  projects: Project[];
  cycles: Cycle[];
  views: View[];
  favorites: Favorite[];
  unreadCount: number;
  /** The model this workspace uses (its own or the instance's), or null when there is none; `enabled` is the workspace's switch. */
  ai: {
    provider: AiSettings['provider'];
    model: string;
    enabled: boolean;
    source: WorkspaceSettings['aiSource'];
  } | null;
}

/** Where a sync client starts: the workspace as of change `seq` in `epoch`. */
export interface SyncSnapshot {
  seq: number;
  epoch: number;
  bootstrap: Bootstrap;
}

/** A page of the issues a sync client keeps (not trashed or archived), in id order. */
export interface SyncIssuePage {
  issues: Issue[];
  /** Pass as `after` for the next page; null when this was the last. */
  next: string | null;
}

/**
 * What changed after `since`, as the reader may see it now. Issues and comments come as their
 * current state, or as deletions when they're gone or out of sight; anything else just says that
 * the bootstrap data (teams, members, labels…) should be loaded again.
 */
export interface SyncChanges {
  /** Read up to here; pass it as `since` next time. */
  seq: number;
  epoch: number;
  /** More changes are waiting: ask again straight away. */
  more: boolean;
  issues: Issue[];
  deletedIssueIds: string[];
  comments: Comment[];
  deletedCommentIds: string[];
  bootstrapChanged: boolean;
  /** Other kinds that changed (notifications, views…), for caches outside the bootstrap. */
  kinds: string[];
}

/** AI: a short summary of an issue and its discussion, in Markdown. */
export interface AiSummary {
  summary: string;
}

/** AI: an issue written from rough notes. Labels are ones the team can use. */
export interface AiDraft {
  title: string;
  description: string;
  priority: Priority;
  labelIds: string[];
}

/** AI: suggested properties for an issue and open issues that may be the same thing. */
export interface AiTriage {
  /** Null when the model has no suggestion beyond what's set. */
  priority: Priority | null;
  /** Labels to add (the issue doesn't have them yet). */
  labelIds: string[];
  duplicates: { id: string; identifier: string; title: string; reason: string }[];
  /** One or two sentences on why. */
  reason: string;
}

export interface InstanceConfig {
  signupMode: 'open' | 'invite';
  hasUsers: boolean;
  /** Whether SMTP is configured, i.e. password resets and email invites work. */
  emailEnabled: boolean;
  allowWorkspaceCreation: boolean;
  version: string;
  /**
   * Where passkeys work: the instance's public origin, when it's https (or localhost); null when
   * passkeys can't be used. They're bound to that address, so other addresses can't offer them.
   */
  passkeyOrigin: string | null;
  offlineSync: OfflineSyncMode;
}

/** One of the signed-in person's passkeys (Settings → Security). */
export interface Passkey {
  id: string;
  name: string;
  /** Synced through a password manager rather than bound to one device. */
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
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

/** An audit entry in the instance admin's log, with the names a workspace view looks up itself. */
export interface AdminAuditEntry extends AuditEntry {
  actorName: string | null;
  actorEmail: string | null;
  actorAvatarColor: string | null;
  workspaceName: string | null;
  /** The person, team or workspace the action was on. */
  targetName: string | null;
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
  /** Largest file people may attach to issues, in megabytes. */
  maxAttachmentMb: number;
  /** Optional AI assistance; null (the default) turns it off everywhere. */
  ai: AiSettings | null;
  /**
   * What workspace admins may change: `own` (use their own model, or turn AI off), `instance`
   * (only turn it off), `locked` (every workspace uses the instance's model).
   */
  workspaceAi: WorkspaceAiPolicy;
  /**
   * Whether browsers keep a copy of each workspace to show at once and work offline: `on` (every
   * device unless someone turns it off there), `optin` (only devices where someone turns it on),
   * or `off`.
   */
  offlineSync: OfflineSyncMode;
}

export const OFFLINE_SYNC_MODES = ['off', 'optin', 'on'] as const;
export type OfflineSyncMode = (typeof OFFLINE_SYNC_MODES)[number];

export const WORKSPACE_AI_POLICIES = ['own', 'instance', 'locked'] as const;
export type WorkspaceAiPolicy = (typeof WORKSPACE_AI_POLICIES)[number];

/** Settings → AI assistance: the workspace's choice, and what each choice would use. */
export interface WorkspaceAi {
  enabled: boolean;
  source: WorkspaceSettings['aiSource'];
  /** The instance's model, if an instance admin set one up. */
  instance: { provider: AiSettings['provider']; model: string } | null;
  /** The workspace's own model; the key only ever masked. */
  own: (Omit<AiSettings, 'apiKey'> & { apiKey: string | null }) | null;
  /** Whether an OpenAI-compatible URL may point into the private network (an instance setting). */
  allowPrivateNetwork: boolean;
  /** What this instance lets workspaces change. */
  policy: WorkspaceAiPolicy;
}

/** The model behind AI assistance. Issue content the asking person can see is sent to it. */
export interface AiSettings {
  /** `anthropic`: the Claude API. `openai`: any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio…). */
  provider: 'anthropic' | 'openai';
  model: string;
  /** Claude: null is https://api.anthropic.com. OpenAI-compatible: the URL ending in /v1. */
  baseUrl: string | null;
  /** Stored encrypted; admins only ever see it masked. Optional for local endpoints. */
  apiKey: string | null;
}

export const INSTANCE_SETTING_DEFAULTS: InstanceSettings = {
  signupMode: 'invite',
  allowWorkspaceCreation: true,
  allowPrivateNetworkTargets: false,
  smtp: null,
  maxAttachmentMb: 25,
  ai: null,
  workspaceAi: 'own',
  offlineSync: 'on',
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
  /** Language for the app, emails and notifications. */
  locale: Locale;
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
  locale: DEFAULT_LOCALE,
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
      comment_reaction: false,
      issue_sla_breached: true,
    },
  },
};

export interface Account extends Me {
  emailVerified: boolean;
  hasPassword: boolean;
  /** An authenticator app or a passkey asks for more than the password. */
  twoFactorEnabled: boolean;
  /** The authenticator app (TOTP) is set up. */
  totpEnabled: boolean;
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
  /** Members must sign in through one of the workspace's SSO providers (owners can still use a password). */
  requireSso: boolean;
  /** Hours an SSO session lasts before signing in again; null = like any session (30 days, sliding). */
  ssoSessionMaxAgeHours: number | null;
  /** Whether personal API keys may be used while SSO is required. */
  allowApiKeysUnderSso: boolean;
  /** Format of "Copy git branch name": {username}, {identifier}, {title}. */
  gitBranchFormat: string;
  /** The workspace's accent colour (#rrggbb); null is Hotline Pink. */
  accentColor: string | null;
  /** AI assistance on or off for this workspace. */
  aiEnabled: boolean;
  /** Whose model: the instance's (if it has one) or the workspace's own (Settings → AI assistance). */
  aiSource: 'instance' | 'workspace';
  /** Role for people the directory (SCIM) adds. */
  scimDefaultRole: 'member' | 'guest';
  /** A directory group links itself to the team with the same name. */
  scimMatchGroupsByName: boolean;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  invitePolicy: 'admins',
  domainAutoJoin: false,
  autoJoinRole: 'member',
  requireSso: false,
  ssoSessionMaxAgeHours: null,
  allowApiKeysUnderSso: false,
  gitBranchFormat: DEFAULT_BRANCH_FORMAT,
  accentColor: null,
  aiEnabled: true,
  aiSource: 'instance',
  scimDefaultRole: 'member',
  scimMatchGroupsByName: false,
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

/** How Ordo talks to a SAML identity provider (from its metadata, or typed in). */
export interface SamlSettings {
  /** The IdP's entity ID: assertions must be issued by it. */
  idpEntityId: string;
  /** Where to send people to sign in (HTTP-Redirect binding). */
  ssoUrl: string;
  /** PEM certificates the IdP signs with; more than one while it rotates keys. */
  certificates: string[];
  /** NameID format to ask for; null lets the IdP choose. */
  nameIdFormat: string | null;
  /** Attribute names, when the IdP doesn't use one of the usual ones. */
  emailAttribute: string | null;
  nameAttribute: string | null;
  /** Where the metadata came from, to fetch it again when certificates change. */
  metadataUrl: string | null;
}

export interface SamlCertificateInfo {
  subject: string;
  notAfter: string;
  fingerprint: string;
}

export interface AuthProvider {
  id: string;
  name: string;
  protocol: 'oidc' | 'saml';
  /** OpenID Connect only. */
  issuer: string | null;
  clientId: string | null;
  scopes: string;
  /** SAML only. */
  saml: (SamlSettings & { certificateInfo: SamlCertificateInfo[] }) | null;
  /** SAML: emails from this IdP may match accounts on the workspace's verified domains. */
  trustEmail: boolean;
  enabled: boolean;
  defaultRole: 'member' | 'guest';
  groupClaim: string | null;
  groupRoles: Record<string, 'admin' | 'member' | 'guest'>;
  createdAt: string;
}

/** A token an identity provider provisions the workspace with. The secret is shown once. */
export interface ScimToken {
  id: string;
  name: string;
  prefix: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** A directory group, as Settings → Authentication → Directory sync lists it. */
export interface ScimGroup {
  id: string;
  displayName: string;
  memberCount: number;
  teamId: string | null;
}

/** What linking a group to a team would change about the team. */
export interface ScimLinkPreview {
  add: { id: string; name: string }[];
  remove: { id: string; name: string }[];
}

/** What the IdP needs to know about Ordo, for one SAML provider. */
export interface SamlServiceProvider {
  entityId: string;
  acsUrl: string;
  metadataUrl: string;
}

/** A sign-in option offered on the login page. */
export interface SsoOption {
  providerId: string;
  name: string;
  workspace: string;
}

/** What the sign-in page offers for an email domain or a workspace URL. */
export interface SsoDiscovery {
  options: SsoOption[];
  /** A matching workspace requires SSO: offer the password only as a fallback (for owners). */
  ssoRequired: boolean;
}

export interface LinkedIdentity {
  id: string;
  provider: string;
  workspace: string;
  email: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Something outside Ordo attached to an issue: a pull request, branch, commit, chat message or plain link. */
export interface IssueLink {
  id: string;
  issueId: string;
  /** `web` for links people add by hand; otherwise the integration's provider (github, slack…). */
  provider: string;
  kind: IssueLinkKind;
  url: string;
  title: string;
  /** Provider state, e.g. open | draft | merged | closed for pull requests. */
  state: string | null;
  /** Display name at the provider. */
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The body of every webhook delivery. */
export interface WebhookPayload {
  /** Unique per event; the same across redeliveries. */
  id: string;
  type: DomainEventType | 'ping';
  createdAt: string;
  workspace: { id: string; slug: string; name: string };
  actor: { id: string; name: string; username: string; kind: UserKind } | null;
  /** web | api | system | import | integration:<id> */
  source: string;
  data: Record<string, unknown>;
  /** For `*.updated`: what changed. */
  changes?: HistoryChange[];
}

export interface Webhook {
  id: string;
  url: string;
  description: string;
  /** Empty: every event. */
  eventTypes: DomainEventType[];
  /** Empty: every team. */
  teamIds: string[];
  enabled: boolean;
  /** Consecutive deliveries that failed after all retries. */
  failureCount: number;
  disabledReason: string | null;
  lastDeliveryAt: string | null;
  lastStatus: number | null;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string | null;
  eventType: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface IntegrationProviderInfo {
  key: string;
  name: string;
  description: string;
  category: 'forge' | 'chat' | 'other';
}

/** A chat channel that receives a feed of issue activity. */
export interface ChatChannel {
  /** The channel's id at the provider (Slack C…, Discord snowflake, Matrix !room:server, Telegram chat id). */
  id: string;
  /** Shown in Ordo only. */
  name?: string;
  /** Teams whose activity is posted; empty means every public team. */
  teamIds: string[];
  events: ChatEventKind[];
  /** Team for issues created from this channel with `new`, unless the message names one. */
  defaultTeamId?: string | null;
  /** Sync comments in threads; on unless false. */
  threads?: boolean;
}

/** One person's verified account on a chat integration. */
export interface ChatAccount {
  id: string;
  username: string | null;
  /** Personal notifications as direct messages. */
  notify: boolean;
  createdAt: string;
}

/** A chat integration as people see it under Account → Connected accounts. */
export interface ChatService {
  integrationId: string;
  provider: string;
  name: string;
  /** How to send the link code, e.g. "/ordo link CODE" or "a direct message to @ordo_bot". */
  linkHint: string;
  accounts: ChatAccount[];
}

export interface Integration {
  id: string;
  provider: string;
  name: string;
  status: 'active' | 'error' | 'disabled';
  lastError: string | null;
  lastEventAt: string | null;
  config: Record<string, unknown>;
  /** Where the provider should send events, when it pushes them. */
  inboundUrl: string | null;
  createdAt: string;
}
