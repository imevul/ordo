import type {
  EstimateScale,
  FavoriteKind,
  MemberRole,
  NotificationType,
  ProjectHealth,
  ProjectStatus,
  StateType,
} from './constants.ts';
import type { IssueDisplay, IssueFilter } from './schemas.ts';

/** API response shapes. Dates are ISO strings on the wire. */

export interface User {
  id: string;
  name: string;
  username: string;
  email: string;
  avatarColor: string;
}

export interface Me extends User {
  workspaces: { id: string; name: string; slug: string; role: MemberRole }[];
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Member extends User {
  role: MemberRole;
  joinedAt: string;
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
  memberIds: string[];
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
  authorId: string;
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
  creatorId: string;
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
  authorId: string;
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
  ownerId: string;
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
  expiresAt: string;
  createdAt: string;
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
  allowWorkspaceCreation: boolean;
  version: string;
}

export interface SearchResults {
  issues: Issue[];
  projects: { id: string; name: string; color: string }[];
}
