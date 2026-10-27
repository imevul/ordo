import { z } from 'zod';
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  CHAT_EVENT_KINDS,
  DOMAIN_EVENT_TYPES,
  ESTIMATE_SCALE_NAMES,
  FAVORITE_KINDS,
  INITIATIVE_STATUSES,
  LOCALES,
  MEMBER_ROLES,
  NOTIFICATION_TYPES,
  PROJECT_HEALTH,
  PROJECT_STATUSES,
  RECURRENCE_UNITS,
  SLUG_PATTERN,
  STATE_TYPES,
  TEAM_KEY_PATTERN,
  TEAM_ROLES,
  USERNAME_PATTERN,
} from './constants.ts';
import { GIT_EVENTS } from './git.ts';
import { CSV_FIELDS, EXPORT_FORMATS } from './imports.ts';
import { HEX_COLOR } from './theme.ts';

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
  /** The language the sign-up page was shown in; it becomes the account's language. */
  locale: z.enum(LOCALES).optional(),
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

export const forgotPasswordSchema = z.object({ email: z.email() });

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema,
});

export const tokenSchema = z.object({ token: z.string().min(10).max(200) });

/** Second login step when two-factor authentication is on: a TOTP code or a recovery code. */
export const mfaLoginSchema = z.object({
  mfaToken: z.string().min(10).max(200),
  code: z.string().trim().min(6).max(20),
});

export const changeEmailSchema = z.object({
  email: z.email().max(254),
  password: z.string().max(200).optional(),
});

export const passwordConfirmSchema = z.object({ password: z.string().max(200).optional() });

export const totpCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const disableTwoFactorSchema = z.object({
  password: z.string().max(200).optional(),
  code: z.string().trim().min(6).max(20),
});

export const updatePreferencesSchema = z.object({
  locale: z.enum(LOCALES).optional(),
  timezone: z.string().max(64).nullable().optional(),
  weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
  notifications: z
    .object({
      emailDigest: z.enum(['off', 'instant', 'hourly', 'daily']).optional(),
      // partialRecord: in Zod 4 an enum-keyed record would require every key.
      email: z.partialRecord(z.enum(NOTIFICATION_TYPES), z.boolean()).optional(),
    })
    .optional(),
});

export const createWorkspaceSchema = z.object({
  name: name,
  slug: z.string().regex(SLUG_PATTERN, 'Lowercase letters, digits and dashes'),
  teamName: name.optional(),
  teamKey: z.string().regex(TEAM_KEY_PATTERN).optional(),
});

export const updateWorkspaceSchema = z.object({
  name: name.optional(),
  slug: z.string().regex(SLUG_PATTERN).optional(),
  defaultTeamId: id.nullable().optional(),
  settings: z
    .object({
      invitePolicy: z.enum(['admins', 'members']).optional(),
      domainAutoJoin: z.boolean().optional(),
      autoJoinRole: z.enum(['member', 'guest']).optional(),
      requireSso: z.boolean().optional(),
      ssoSessionMaxAgeHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 90)
        .nullable()
        .optional(),
      allowApiKeysUnderSso: z.boolean().optional(),
      gitBranchFormat: z.string().trim().min(1).max(100).optional(),
      accentColor: z.string().regex(HEX_COLOR, 'Use a #rrggbb colour').nullable().optional(),
      aiEnabled: z.boolean().optional(),
      aiSource: z.enum(['instance', 'workspace']).optional(),
    })
    .optional(),
});

export const addDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      'Enter a domain like example.com',
    ),
});

export const transferOwnershipSchema = z.object({
  userId: id,
  /** Step down to admin after handing over. */
  stepDown: z.boolean().default(true),
});

export const deleteWorkspaceSchema = z.object({ confirmSlug: z.string() });

export const adminUpdateUserSchema = z.object({
  disabled: z.boolean().optional(),
  isInstanceAdmin: z.boolean().optional(),
});

export const adminSettingsSchema = z.object({
  signupMode: z.enum(['open', 'invite']).optional(),
  allowWorkspaceCreation: z.boolean().optional(),
  allowPrivateNetworkTargets: z.boolean().optional(),
  maxAttachmentMb: z.number().int().min(1).max(1024).optional(),
  /** `url: ''` keeps the stored URL (the UI never sees it); `smtp: null` turns email off. */
  smtp: z
    .object({ url: z.string().max(2000), from: z.string().min(3).max(200) })
    .nullable()
    .optional(),
  /** `apiKey: ''` keeps the stored key, `null` removes it; `ai: null` turns AI off. */
  ai: z
    .object({
      provider: z.enum(['anthropic', 'openai']),
      model: z.string().trim().min(1).max(200),
      baseUrl: z
        .url({ protocol: /^https?$/ })
        .max(500)
        .nullable(),
      apiKey: z.string().trim().max(500).nullable(),
    })
    .nullable()
    .optional(),
});

/** Turns rough notes (what's typed into the new-issue form) into an issue draft. */
export const aiDraftSchema = z.object({
  teamId: id,
  text: z.string().trim().min(1).max(20_000),
});

export const createInviteSchema = z.object({
  /** One invite per address (emailed when SMTP is set up). Omit for a single shareable link. */
  emails: z.array(z.email()).max(100).optional(),
  email: z.email().optional(),
  // Ownership is granted by an owner after joining, never through an invite link.
  role: z.enum(['admin', 'member', 'guest']).default('member'),
  teamIds: z.array(id).max(50).default([]),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});

export const updateMemberSchema = z.object({
  role: z.enum(MEMBER_ROLES).optional(),
  suspended: z.boolean().optional(),
});

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
  gitAutomation: z.partialRecord(z.enum(GIT_EVENTS), z.union([id, z.literal('none')])).optional(),
  slaHours: z
    .partialRecord(
      z.enum(['1', '2', '3', '4']),
      z
        .number()
        .int()
        .min(1)
        .max(24 * 365),
    )
    .optional(),
  autoArchiveMonths: z
    .union([z.literal(1), z.literal(3), z.literal(6), z.literal(9), z.literal(12)])
    .nullish(),
  cycleAutomation: z
    .object({
      enabled: z.boolean(),
      weeks: z.number().int().min(1).max(8),
      cooldownWeeks: z.number().int().min(0).max(2),
      startDay: z.number().int().min(0).max(6),
      upcoming: z.number().int().min(1).max(6),
      rollOver: z.boolean(),
      addStarted: z.boolean(),
    })
    .partial()
    .optional(),
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

export type CreateLabelInput = z.infer<typeof createLabelSchema>;

const templateFields = {
  name: z.string().trim().min(1).max(80),
  // Not trimmed: "Bug: " is a prefix to type after.
  title: z.string().max(500),
  description: markdown,
  stateId: id.nullable(),
  priority: z.number().int().min(0).max(4).nullable(),
  assigneeId: id.nullable(),
  projectId: id.nullable(),
  estimate: z.number().int().min(0).max(100).nullable(),
  labelIds: z.array(id).max(50),
};

export const createTemplateSchema = z.object({
  ...templateFields,
  teamId: id.nullish(),
  title: templateFields.title.default(''),
  description: markdown.default(''),
  stateId: id.nullish(),
  priority: templateFields.priority.optional(),
  assigneeId: id.nullish(),
  projectId: id.nullish(),
  estimate: templateFields.estimate.optional(),
  labelIds: templateFields.labelIds.default([]),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

const triageRuleFields = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  conditions: z.object({
    sources: z
      .array(z.enum(['web', 'api', 'mcp', 'integration', 'email']))
      .max(5)
      .optional(),
    text: z.string().trim().max(200).optional(),
    labelIds: z.array(id).max(20).optional(),
    priorities: z.array(z.number().int().min(0).max(4)).max(5).optional(),
  }),
  actions: z.object({
    priority: z.number().int().min(0).max(4).optional(),
    labelIds: z.array(id).max(20).optional(),
    assigneeId: id.optional(),
    rotation: z.array(id).min(1).max(50).optional(),
    stateId: id.optional(),
  }),
};
export const createTriageRuleSchema = z.object(triageRuleFields).partial({ enabled: true });
export const updateTriageRuleSchema = z
  .object(triageRuleFields)
  .extend({ position: z.number() })
  .partial();

export const createRecurringSchema = z.object({
  templateId: id,
  teamId: id,
  every: z.number().int().min(1).max(52),
  unit: z.enum(RECURRENCE_UNITS),
  nextOn: isoDate,
});
export type CreateRecurringInput = z.infer<typeof createRecurringSchema>;
export const updateRecurringSchema = createRecurringSchema
  .pick({ every: true, unit: true, nextOn: true })
  .extend({ paused: z.boolean() })
  .partial();

/** The team can't change: a status or labels only make sense in the team they were picked for. */
export const updateTemplateSchema = z.object(templateFields).partial();
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const updateLabelSchema = createLabelSchema.partial();

export const createIssueSchema = z.object({
  teamId: id,
  title: z.string().trim().min(1).max(500),
  description: markdown.optional(),
  stateId: id.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assigneeId: id.nullish(),
  projectId: id.nullish(),
  milestoneId: id.nullish(),
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
  milestoneId: id.nullish(),
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
  milestoneIds: z.array(idOrNone).optional(),
  cycleIds: z.array(idOrNone).optional(),
  parentId: id.optional(),
  subscribedBy: z.literal('me').optional(),
  q: z.string().max(200).optional(),
  trashed: z.boolean().optional(),
  /** Archived issues are left out unless included, or asked for alone. */
  archived: z.enum(['include', 'only']).optional(),
});
export type IssueFilter = z.infer<typeof issueFilterSchema>;

export const GROUP_BY_OPTIONS = [
  'state',
  'priority',
  'assignee',
  'project',
  'milestone',
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

/** One emoji, skin tones, flags, keycaps and ZWJ sequences included; no text. */
export function isSingleEmoji(value: string) {
  if (!value || value.length > 32 || /[\s\p{L}]/u.test(value)) return false;
  if ([...new Intl.Segmenter().segment(value)].length !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value);
}

export const reactionEmojiSchema = z.string().refine(isSingleEmoji, 'Must be a single emoji');

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
  initiativeId: id.nullish(),
});

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, 'Expected a domain like acme.com');

export const createCustomerSchema = z.object({
  name: name,
  domains: z.array(domain).max(20).default([]),
  ownerId: id.nullish(),
  notes: z.string().max(5000).nullish(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export const updateCustomerSchema = createCustomerSchema.partial();

export const createCustomerRequestSchema = z.object({
  customerId: id,
  body: z.string().trim().max(10_000).default(''),
  contact: z.string().trim().max(300).nullish(),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2000),
  keys: z.object({
    // A P-256 point (65 bytes) and a 16-byte secret, base64url, as PushSubscription.toJSON() has them.
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,88}={0,2}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{21,24}={0,2}$/),
  }),
});

export const snoozeSchema = z.object({
  ids: z.array(id).min(1).max(200),
  /** A future time, or null to wake them now. */
  until: z.iso.datetime({ offset: true }).nullable(),
});

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: markdown.default(''),
});
export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: markdown.optional(),
  /** The version this edit is based on; a newer saved one turns the edit into a 409. */
  baseUpdatedAt: z.string().optional(),
  sortOrder: z.number().optional(),
});

export const createInitiativeSchema = z.object({
  name: name,
  description: markdown.nullish(),
  status: z.enum(INITIATIVE_STATUSES).optional(),
  ownerId: id.nullish(),
  targetDate: isoDate.nullish(),
  color: color.optional(),
});
export type CreateInitiativeInput = z.infer<typeof createInitiativeSchema>;
export const updateInitiativeSchema = createInitiativeSchema
  .partial()
  .extend({ sortOrder: z.number().optional() });

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const createMilestoneSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000).nullish(),
  targetDate: isoDate.nullish(),
});
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export const updateMilestoneSchema = createMilestoneSchema
  .partial()
  .extend({ sortOrder: z.number().optional() });

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
export type CreateCycleInput = z.infer<typeof createCycleSchema>;

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

const groupRolesSchema = z.record(z.string().min(1).max(200), z.enum(['admin', 'member', 'guest']));

const authProviderFields = {
  name: z.string().trim().min(1).max(80),
  issuer: z.url().max(500),
  clientId: z.string().trim().min(1).max(500),
  scopes: z.string().trim().max(500),
  enabled: z.boolean(),
  defaultRole: z.enum(['member', 'guest']),
  groupClaim: z.string().trim().max(100).nullable(),
  groupRoles: groupRolesSchema,
};

export const createAuthProviderSchema = z.object({
  ...authProviderFields,
  clientSecret: z.string().min(1).max(2000),
  scopes: authProviderFields.scopes.default('openid email profile'),
  enabled: authProviderFields.enabled.default(true),
  defaultRole: authProviderFields.defaultRole.default('member'),
  groupClaim: authProviderFields.groupClaim.optional(),
  groupRoles: authProviderFields.groupRoles.default({}),
});

// No defaults here: a PATCH must leave unmentioned fields alone.
export const updateAuthProviderSchema = z
  .object(authProviderFields)
  .partial()
  .extend({
    /** Empty keeps the stored secret. */
    clientSecret: z.string().max(2000).optional(),
  });

export const createWebhookSchema = z.object({
  url: z.url().max(2000),
  description: z.string().trim().max(200).default(''),
  eventTypes: z.array(z.enum(DOMAIN_EVENT_TYPES)).default([]),
  teamIds: z.array(z.uuid()).default([]),
  enabled: z.boolean().default(true),
});

export const updateWebhookSchema = z
  .object({
    url: z.url().max(2000),
    description: z.string().trim().max(200),
    eventTypes: z.array(z.enum(DOMAIN_EVENT_TYPES)),
    teamIds: z.array(z.uuid()),
    enabled: z.boolean(),
  })
  .partial();

export const createIssueLinkSchema = z.object({
  url: z.url().max(2000),
  title: z.string().trim().max(300).optional(),
});

/** A chat channel's feed subscription, stored in a chat integration's `config.channels`. */
export const chatChannelSchema = z.object({
  id: z.string().trim().min(1, 'Every channel needs an id').max(200),
  name: z.string().trim().max(100).optional(),
  teamIds: z.array(z.uuid()).max(100).default([]),
  events: z.array(z.enum(CHAT_EVENT_KINDS)).max(CHAT_EVENT_KINDS.length).default([]),
  defaultTeamId: z.uuid().nullish(),
  /**
   * Sync comments in threads (on unless false): an issue's later activity goes into the thread
   * of its first post here, and replies in that thread become comments.
   */
  threads: z.boolean().optional(),
});
export const chatChannelsSchema = z.array(chatChannelSchema).max(100);

/** Where each source team, status, person, label and project goes (see `ImportMapping`). */
export const importMappingSchema = z.object({
  teams: z.record(
    z.string(),
    z.union([
      z.object({ teamId: id }),
      z.object({
        create: z.object({
          name,
          key: z.string().regex(TEAM_KEY_PATTERN, 'Uppercase letters and digits, max 7, e.g. ENG'),
        }),
      }),
      z.object({ skip: z.literal(true) }),
    ]),
  ),
  statuses: z.record(z.string(), z.record(z.string(), z.union([id, z.enum(STATE_TYPES)]))),
  users: z.record(z.string(), z.union([id, z.literal('placeholder')]).nullable()),
  labels: z.record(z.string(), z.union([id, z.enum(['create', 'skip'])])),
  projects: z.record(z.string(), z.union([id, z.enum(['create', 'skip'])])),
  keepNumbers: z.boolean(),
});

/** CSV settings: which column feeds which field. */
export const csvImportConfigSchema = z.object({
  columns: z.partialRecord(z.enum(CSV_FIELDS), z.string().max(200).nullable()),
});

export const updateImportSchema = z.object({
  mapping: importMappingSchema.optional(),
  config: csvImportConfigSchema.optional(),
});

export const mergePlaceholderSchema = z.object({ userId: id });

/** Starts an import from another tracker's API (file sources are uploaded instead). */
export const createApiImportSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('linear'), apiKey: z.string().trim().min(10).max(500) }),
  z.object({
    source: z.literal('github'),
    token: z.string().trim().min(10).max(500),
    repos: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[\w.-]+\/[\w.-]+$/, 'Repositories look like owner/name'),
      )
      .min(1)
      .max(20),
    /** GitHub Enterprise Server's API, e.g. https://github.example.com/api/v3 */
    apiUrl: z.url().max(500).optional(),
  }),
  z.object({
    source: z.literal('forgejo'),
    /** The Forgejo or Gitea server, e.g. https://codeberg.org */
    baseUrl: z.url().max(500),
    token: z.string().trim().min(10).max(500),
    repos: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[\w.-]+\/[\w.-]+$/, 'Repositories look like owner/name'),
      )
      .min(1)
      .max(20),
  }),
  z.object({
    source: z.literal('gitlab'),
    /** gitlab.com, or a self-managed GitLab. */
    baseUrl: z.url().max(500).default('https://gitlab.com'),
    token: z.string().trim().min(10).max(500),
    /** Project paths, with their groups: group/subgroup/project. */
    projects: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[\w.-]+(\/[\w.-]+)+$/, 'Projects look like group/project'),
      )
      .min(1)
      .max(20),
  }),
  z.object({
    source: z.literal('jira'),
    /** https://acme.atlassian.net, or a Jira Data Center's base URL. */
    siteUrl: z.url().max(500),
    /** Jira Cloud: the account's email, with an API token as `token`. Data Center: leave it out. */
    email: z.email().max(320).optional(),
    token: z.string().trim().min(10).max(500),
    /** Project keys; every project the token can see when left out. */
    projects: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'Project keys look like ENG'),
      )
      .max(50)
      .optional(),
  }),
]);
export type CreateApiImportInput = z.infer<typeof createApiImportSchema>;

export const createExportSchema = z.object({ format: z.enum(EXPORT_FORMATS) });

/** The instance's Slack app, for one-click installs. Blank secrets keep the stored ones. */
export const slackAppSchema = z.object({
  delivery: z.enum(['events', 'socket']),
  clientId: z
    .string()
    .trim()
    .regex(/^\d+\.\d+$/, 'The client ID looks like 1234567890.1234567890'),
  clientSecret: z.string().trim().max(200).optional(),
  signingSecret: z.string().trim().max(200).optional(),
  appToken: z.string().trim().max(300).optional(),
});

/** Filters for a workspace's audit log; `before` + `beforeId` page to older entries. */
export const auditQuerySchema = z.object({
  category: z.enum(Object.keys(AUDIT_CATEGORIES) as [AuditCategory, ...AuditCategory[]]).optional(),
  actorId: z.uuid().optional(),
  /** Inclusive. */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Exclusive. */
  to: z.iso.datetime({ offset: true }).optional(),
  /** Matched against the action, its target, IP address and details. */
  q: z.string().trim().max(200).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  beforeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** The instance audit log: `scope` instance-level entries or everything, or one workspace's. */
export const adminAuditQuerySchema = auditQuerySchema.extend({
  scope: z.enum(['instance', 'all']).default('instance'),
  workspaceId: z.uuid().optional(),
});

/** A workspace's own AI model. `apiKey: ''` keeps the stored key, `null` removes it. */
export const workspaceAiProviderSchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  model: z.string().trim().min(1).max(200),
  /** OpenAI-compatible only: the URL ending in /v1. */
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullable(),
  apiKey: z.string().trim().max(500).nullable(),
});
