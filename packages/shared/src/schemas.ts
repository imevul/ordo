import { z } from 'zod';
import {
  ESTIMATE_SCALE_NAMES,
  FAVORITE_KINDS,
  MEMBER_ROLES,
  PROJECT_HEALTH,
  PROJECT_STATUSES,
  SLUG_PATTERN,
  STATE_TYPES,
  TEAM_KEY_PATTERN,
  TEAM_ROLES,
  USERNAME_PATTERN,
} from './constants.ts';

/** Request payload schemas, shared by the API (validation) and the web client (forms). */

const id = z.uuid();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex color like #ff1493');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date like 2026-01-31');
const name = z.string().trim().min(1).max(120);
const markdown = z.string().max(100_000);

export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(200);

export const signupSchema = z.object({
  name: name,
  email: z.email().max(254),
  password: passwordSchema,
  inviteToken: z.string().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});

export const updateMeSchema = z.object({
  name: name.optional(),
  username: z.string().regex(USERNAME_PATTERN, 'Lowercase letters, digits, . _ -').optional(),
  avatarColor: color.optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const createApiKeySchema = z.object({ name: name });

export const createWorkspaceSchema = z.object({
  name: name,
  slug: z.string().regex(SLUG_PATTERN, 'Lowercase letters, digits and dashes'),
  teamName: name.optional(),
  teamKey: z.string().regex(TEAM_KEY_PATTERN).optional(),
});

export const updateWorkspaceSchema = z.object({
  name: name.optional(),
  slug: z.string().regex(SLUG_PATTERN).optional(),
});

export const createInviteSchema = z.object({
  email: z.email().optional(),
  // Ownership is granted by an owner after joining, never through an invite link.
  role: z.enum(['admin', 'member', 'guest']).default('member'),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});

export const updateMemberSchema = z.object({ role: z.enum(MEMBER_ROLES) });

export const addTeamMemberSchema = z.object({
  userId: id.optional(),
  role: z.enum(TEAM_ROLES).default('member'),
});

export const updateTeamMemberSchema = z.object({ role: z.enum(TEAM_ROLES) });

export const createTeamSchema = z.object({
  private: z.boolean().optional(),
  name: name,
  key: z.string().regex(TEAM_KEY_PATTERN, 'Uppercase letters and digits, max 7, e.g. ENG'),
  description: z.string().max(2000).nullish(),
  color: color.optional(),
});

export const updateTeamSchema = z.object({
  name: name.optional(),
  key: z.string().regex(TEAM_KEY_PATTERN).optional(),
  description: z.string().max(2000).nullish(),
  color: color.optional(),
  estimateScale: z.enum(ESTIMATE_SCALE_NAMES as [string, ...string[]]).optional(),
  triageEnabled: z.boolean().optional(),
  cyclesEnabled: z.boolean().optional(),
  private: z.boolean().optional(),
  defaultStateId: id.nullish(),
});

export const createStateSchema = z.object({
  name: name,
  type: z.enum(STATE_TYPES),
  color: color,
  description: z.string().max(500).nullish(),
});

export const updateStateSchema = z.object({
  name: name.optional(),
  color: color.optional(),
  description: z.string().max(500).nullish(),
  position: z.number().optional(),
});

export const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: color,
  teamId: id.nullish(),
});

export const updateLabelSchema = createLabelSchema.partial();

export const createIssueSchema = z.object({
  teamId: id,
  title: z.string().trim().min(1).max(500),
  description: markdown.optional(),
  stateId: id.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assigneeId: id.nullish(),
  projectId: id.nullish(),
  cycleId: id.nullish(),
  parentId: id.nullish(),
  estimate: z.number().int().min(0).max(100).nullish(),
  dueDate: isoDate.nullish(),
  labelIds: z.array(id).max(50).optional(),
  sortOrder: z.number().optional(),
});
export type CreateIssueInput = z.infer<typeof createIssueSchema>;

export const updateIssueSchema = z.object({
  teamId: id.optional(),
  title: z.string().trim().min(1).max(500).optional(),
  description: markdown.optional(),
  stateId: id.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assigneeId: id.nullish(),
  projectId: id.nullish(),
  cycleId: id.nullish(),
  parentId: id.nullish(),
  estimate: z.number().int().min(0).max(100).nullish(),
  dueDate: isoDate.nullish(),
  labelIds: z.array(id).max(50).optional(),
  addLabelIds: z.array(id).max(50).optional(),
  removeLabelIds: z.array(id).max(50).optional(),
  sortOrder: z.number().optional(),
});
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;

export const batchUpdateIssuesSchema = z.object({
  ids: z.array(id).min(1).max(250),
  patch: updateIssueSchema.omit({ teamId: true, sortOrder: true }),
});

export const batchDeleteIssuesSchema = z.object({ ids: z.array(id).min(1).max(250) });

/** `me` resolves to the requesting user; `none` matches a null value. */
const userRef = z.union([id, z.literal('me')]);
const userRefOrNone = z.union([id, z.literal('me'), z.literal('none')]);
const idOrNone = z.union([id, z.literal('none')]);

export const issueFilterSchema = z.object({
  teamId: id.optional(),
  stateIds: z.array(id).optional(),
  stateTypes: z.array(z.enum(STATE_TYPES)).optional(),
  priorities: z.array(z.number().int().min(0).max(4)).optional(),
  assigneeIds: z.array(userRefOrNone).optional(),
  creatorIds: z.array(userRef).optional(),
  labelIds: z.array(id).optional(),
  projectIds: z.array(idOrNone).optional(),
  cycleIds: z.array(idOrNone).optional(),
  parentId: id.optional(),
  subscribedBy: z.literal('me').optional(),
  q: z.string().max(200).optional(),
  trashed: z.boolean().optional(),
});
export type IssueFilter = z.infer<typeof issueFilterSchema>;

export const GROUP_BY_OPTIONS = [
  'state',
  'priority',
  'assignee',
  'project',
  'cycle',
  'label',
  'none',
] as const;
export type GroupBy = (typeof GROUP_BY_OPTIONS)[number];
export const ORDER_BY_OPTIONS = [
  'manual',
  'priority',
  'updatedAt',
  'createdAt',
  'dueDate',
  'title',
] as const;
export type OrderBy = (typeof ORDER_BY_OPTIONS)[number];

export const issueDisplaySchema = z.object({
  layout: z.enum(['list', 'board']).default('list'),
  groupBy: z.enum(GROUP_BY_OPTIONS).default('state'),
  orderBy: z.enum(ORDER_BY_OPTIONS).default('manual'),
  showCompleted: z.boolean().default(true),
  showSubIssues: z.boolean().default(true),
  showEmptyGroups: z.boolean().default(false),
});
export type IssueDisplay = z.infer<typeof issueDisplaySchema>;
export const DEFAULT_ISSUE_DISPLAY: IssueDisplay = issueDisplaySchema.parse({});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(50_000),
  parentId: id.nullish(),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({ body: z.string().trim().min(1).max(50_000) });

export const createRelationSchema = z.object({
  type: z.enum(['blocks', 'blocked_by', 'related', 'duplicate_of']),
  relatedIssueId: id,
});

export type CreateRelationInput = z.infer<typeof createRelationSchema>;

export const createProjectSchema = z.object({
  name: name,
  description: markdown.nullish(),
  color: color.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  leadId: id.nullish(),
  startDate: isoDate.nullish(),
  targetDate: isoDate.nullish(),
  teamIds: z.array(id).min(1),
});

export const updateProjectSchema = createProjectSchema
  .partial()
  .extend({ sortOrder: z.number().optional() });

export const createProjectUpdateSchema = z.object({
  body: z.string().trim().min(1).max(50_000),
  health: z.enum(PROJECT_HEALTH),
});

export const createCycleSchema = z
  .object({
    name: z.string().trim().max(120).nullish(),
    description: z.string().max(5000).nullish(),
    startsAt: isoDate,
    endsAt: isoDate,
  })
  .refine((c) => c.endsAt > c.startsAt, {
    message: 'End date must be after start date',
    path: ['endsAt'],
  });

export const updateCycleSchema = z.object({
  name: z.string().trim().max(120).nullish(),
  description: z.string().max(5000).nullish(),
  startsAt: isoDate.optional(),
  endsAt: isoDate.optional(),
});

export const createViewSchema = z.object({
  name: name,
  description: z.string().max(2000).nullish(),
  teamId: id.nullish(),
  shared: z.boolean().default(true),
  filters: issueFilterSchema,
  display: issueDisplaySchema.optional(),
});

export const updateViewSchema = z.object({
  name: name.optional(),
  description: z.string().max(2000).nullish(),
  shared: z.boolean().optional(),
  filters: issueFilterSchema.optional(),
  display: issueDisplaySchema.optional(),
});

export const createFavoriteSchema = z.object({
  kind: z.enum(FAVORITE_KINDS),
  targetId: id,
});
