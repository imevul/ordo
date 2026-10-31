import { z } from 'zod';
import { issueFilterSchema } from './schemas.ts';

/**
 * Dashboards: widgets pinned to a page, laid out on a grid. Personal (private) or shared, for the
 * workspace or one team, like saved views. Widgets are stored with the dashboard, in order; each
 * spans `w` of `DASHBOARD_COLUMNS` columns and `h` rows, and the grid packs them densely.
 */

export const DASHBOARD_COLUMNS = 4;
export const DASHBOARD_MAX_ROWS = 3;
export const DASHBOARD_MAX_WIDGETS = 30;

export const DASHBOARD_WIDGET_TYPES = ['chart', 'view', 'count', 'agents'] as const;
export type DashboardWidgetType = (typeof DASHBOARD_WIDGET_TYPES)[number];

/**
 * Insights charts a widget can show. `burnUp` and `cumulativeFlow` are over the workspace, a
 * team, a project or a team's current cycle; `burndown` needs a project, `velocity` a team;
 * `breakdown` and `flow` (created vs completed per week) are over the issues a filter matches.
 */
export const DASHBOARD_CHARTS = [
  'burnUp',
  'burndown',
  'cumulativeFlow',
  'velocity',
  'breakdown',
  'flow',
] as const;
export type DashboardChart = (typeof DASHBOARD_CHARTS)[number];

/** What a breakdown chart groups by. */
export const BREAKDOWN_SLICES = [
  'state',
  'assignee',
  'priority',
  'label',
  'project',
  'team',
  'cycle',
] as const;
export type BreakdownSlice = (typeof BREAKDOWN_SLICES)[number];

/** Weeks back a timeline chart shows. */
export const DASHBOARD_WEEKS = [4, 12, 26, 52] as const;

const id = z.uuid();
const measure = z.enum(['count', 'estimate']).default('count');

const base = {
  /** Stable within the dashboard (the client makes it up), so edits keep their place. */
  id: z.string().min(1).max(64),
  /** Shown above the widget; a default one follows from what it shows. */
  title: z.string().trim().max(120).nullish(),
  w: z.number().int().min(1).max(DASHBOARD_COLUMNS).default(2),
  h: z.number().int().min(1).max(DASHBOARD_MAX_ROWS).default(1),
};

const chartWidget = z
  .object({
    ...base,
    type: z.literal('chart'),
    chart: z.enum(DASHBOARD_CHARTS),
    /** Timeline charts: one team or one project; neither is the whole workspace. */
    teamId: id.nullish(),
    projectId: id.nullish(),
    /** With `teamId`: the team's current cycle, whichever that is when the dashboard is opened. */
    currentCycle: z.boolean().optional(),
    weeks: z.union([z.literal(4), z.literal(12), z.literal(26), z.literal(52)]).optional(),
    /** Breakdown and flow: the issues counted. */
    filters: issueFilterSchema.optional(),
    slice: z.enum(BREAKDOWN_SLICES).optional(),
    measure,
  })
  .superRefine((w, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', message });
    };
    need(!(w.teamId && w.projectId), 'Give a team or a project, not both');
    need(!w.currentCycle || !!w.teamId, 'The current cycle needs a team');
    if (w.chart === 'burndown') need(!!w.projectId, 'A burndown is over a project');
    if (w.chart === 'velocity') need(!!w.teamId, 'Velocity is over a team');
  });

const viewWidget = z.object({
  ...base,
  type: z.literal('view'),
  viewId: id,
  /** Issues listed; the rest are a link away. */
  limit: z.number().int().min(1).max(50).default(8),
});

const countWidget = z.object({
  ...base,
  type: z.literal('count'),
  filters: issueFilterSchema,
  measure,
});

const agentsWidget = z.object({
  ...base,
  type: z.literal('agents'),
  /** Runs started in the last `days` days. */
  days: z.number().int().min(1).max(90).default(7),
  agentId: id.nullish(),
  teamId: id.nullish(),
});

export const dashboardWidgetSchema = z.discriminatedUnion('type', [
  chartWidget,
  viewWidget,
  countWidget,
  agentsWidget,
]);
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;
export type DashboardWidgetInput = z.input<typeof dashboardWidgetSchema>;

const widgets = z
  .array(dashboardWidgetSchema)
  .max(DASHBOARD_MAX_WIDGETS)
  .refine((ws) => new Set(ws.map((w) => w.id)).size === ws.length, 'Widget ids must be unique');

const name = z.string().trim().min(1).max(120);

export const createDashboardSchema = z.object({
  name,
  description: z.string().max(2000).nullish(),
  /** A team's dashboard: only people who can read the team see it. */
  teamId: id.nullish(),
  shared: z.boolean().default(true),
  widgets: widgets.default([]),
});
export type CreateDashboardInput = z.infer<typeof createDashboardSchema>;

/** The widgets are replaced as a whole: the editor saves the layout it shows. */
export const updateDashboardSchema = z.object({
  name: name.optional(),
  description: z.string().max(2000).nullish(),
  shared: z.boolean().optional(),
  widgets: widgets.optional(),
});
export type UpdateDashboardInput = z.infer<typeof updateDashboardSchema>;

export interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  teamId: string | null;
  shared: boolean;
  widgets: DashboardWidget[];
  createdAt: string;
  updatedAt: string;
}

/** `GET /agent-activity`: runs started in the last `days` days (on issues the caller can read). */
export const agentActivityQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  agentId: id.optional(),
  teamId: id.optional(),
});

export interface AgentActivity {
  agentId: string;
  runs: number;
  succeeded: number;
  failed: number;
  /** Queued, running or waiting now. */
  open: number;
  costUsd: number;
  durationMs: number;
}

export interface AgentActivityReport {
  /** The first instant counted. */
  since: string;
  agents: AgentActivity[];
}
