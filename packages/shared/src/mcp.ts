import { z } from 'zod';
import { STATE_TYPES } from './constants.ts';

/**
 * Arguments of the MCP server's tools (`/api/w/:ws/mcp`). Agents refer to things by name: a team
 * by key, a status or label by name, a person by username or email, so most fields are strings
 * that the API resolves within the caller's access. UUIDs work everywhere too.
 */

const ref = (what: string) => z.string().trim().min(1).max(200).describe(what);
const team = ref('Team key (e.g. "ENG"), name or id');
const issue = ref('Issue identifier (e.g. "ENG-42") or id');
const person = ref('"me", a username, an email address, a name or a user id');
const priority = z
  .union([z.number().int().min(0).max(4), z.enum(['none', 'urgent', 'high', 'medium', 'low'])])
  .describe('0 none, 1 urgent, 2 high, 3 medium, 4 low (number or name)');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date like 2026-01-31');
const limit = (max: number, fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(fallback)
    .describe(`Maximum results (default ${fallback}, at most ${max})`);
const cycle = ref('"current", a cycle number of the team, a cycle name or id');
const project = ref('Project name or id');
const milestone = ref('Milestone name within the project, or id');
const fieldName = ref('Custom field name (see list_custom_fields) or id');

/** Custom field values by field name, in the terms people use; resolved against the issue's team. */
const customFieldValues = z
  .record(
    fieldName,
    z.union([
      z.string().max(10_000),
      z.number().finite(),
      z.array(z.string().trim().min(1).max(200)).max(200),
      z.null(),
    ]),
  )
  .describe(
    'Custom fields by name (see list_custom_fields): an option name (select), a list of option names (multi-select), a number, a date like 2026-01-31, text, or a person given like assignee; null clears. Fields left out keep their value.',
  );

const issueFields = {
  description: z.string().max(100_000).describe('Markdown').optional(),
  status: ref('Status name within the team (e.g. "In Progress") or id').optional(),
  priority: priority.optional(),
  assignee: person.nullable().optional(),
  labels: z.array(ref('Label name or id')).max(50).optional(),
  project: ref('Project name or id').nullable().optional(),
  cycle: cycle.nullable().optional(),
  milestone: milestone
    .nullable()
    .optional()
    .describe("Milestone of the issue's project (or of project, when given)"),
  parent: issue.nullable().optional().describe('Parent issue identifier, makes this a sub-issue'),
  estimate: z.number().int().min(0).max(100).nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  customFields: customFieldValues.optional(),
};

/** A finished run, by issue (and agent) since runs have no identifier people type, or by id. */
const failedRun = z.object({
  issue: issue.optional().describe('Issue identifier (e.g. "ENG-42") or id; required without run'),
  agent: ref('Only runs of this agent: username, name or id').optional(),
  run: z.uuid().optional().describe('The run id (see agent_runs), instead of issue and agent'),
});

export const mcpToolSchemas = {
  list_teams: z.object({}),
  list_statuses: z.object({ team }),
  list_members: z.object({
    query: z.string().max(200).optional().describe('Filter by name, username or email'),
  }),
  list_labels: z.object({ team: team.optional().describe('Only labels usable in this team') }),
  list_custom_fields: z.object({
    team: team.optional().describe("Only the fields this team's issues have"),
  }),
  list_projects: z.object({ team: team.optional() }),
  list_cycles: z.object({
    team: team.optional(),
    includePast: z.boolean().default(false).describe('Include cycles that have ended'),
  }),
  create_cycle: z.object({
    team,
    startsAt: isoDate.describe('First day'),
    endsAt: isoDate.describe('Day after the last day (the next cycle starts here)'),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(5000).optional(),
  }),
  update_cycle: z.object({
    team,
    cycle,
    startsAt: isoDate.optional(),
    endsAt: isoDate.optional(),
    name: z.string().trim().min(1).max(120).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
  }),
  create_milestone: z.object({
    project,
    name: z.string().trim().min(1).max(120),
    targetDate: isoDate.optional(),
    description: z.string().max(5000).optional(),
  }),
  update_milestone: z.object({
    project,
    milestone,
    name: z.string().trim().min(1).max(120).optional(),
    targetDate: isoDate.nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
  }),
  search_issues: z.object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Words to find in titles, descriptions and comments (best matches first), or an identifier',
      ),
    team: team.optional(),
    status: z.array(ref('Status name or id')).optional(),
    statusType: z.array(z.enum(STATE_TYPES)).optional(),
    assignee: z.array(z.union([person, z.literal('none')])).optional(),
    creator: z.array(person).optional(),
    labels: z.array(ref('Label name or id')).optional().describe('Issues with any of these'),
    project: ref('Project name or id, or "none"').optional(),
    cycle: z.union([cycle, z.literal('none')]).optional(),
    priority: z.array(priority).optional(),
    customFields: z
      .record(
        fieldName,
        z
          .array(
            ref(
              'An option name, a person, a number or date written out, the text, or "none" for no value',
            ),
          )
          .min(1)
          .max(100),
      )
      .optional()
      .describe('Custom field name → values; issues with any of them (all fields must match)'),
    subscribed: z.boolean().optional().describe('Only issues I am subscribed to'),
    includeClosed: z
      .boolean()
      .default(false)
      .describe('Include completed and canceled issues (implied by status or statusType)'),
    limit: limit(250, 50),
  }),
  my_issues: z.object({
    includeClosed: z.boolean().default(false),
    limit: limit(250, 50),
  }),
  get_issue: z.object({
    issue,
    comments: z.boolean().default(true).describe('Include the comment thread'),
  }),
  create_issue: z.object({
    team,
    title: z.string().trim().min(1).max(500),
    ...issueFields,
  }),
  update_issue: z.object({
    issue,
    title: z.string().trim().min(1).max(500).optional(),
    team: team.optional().describe('Move the issue to another team'),
    ...issueFields,
    labels: issueFields.labels.describe('Replaces all labels'),
    addLabels: z.array(ref('Label name or id')).max(50).optional(),
    removeLabels: z.array(ref('Label name or id')).max(50).optional(),
  }),
  add_relation: z.object({
    issue,
    type: z
      .enum(['blocks', 'blocked_by', 'related', 'duplicate_of'])
      .describe('How issue relates to other: it blocks other, is blocked by it, …'),
    other: issue.describe('The other issue (e.g. "ENG-7")'),
  }),
  remove_relation: z.object({ issue, other: issue.describe('The other issue (e.g. "ENG-7")') }),
  add_comment: z.object({
    issue,
    body: z.string().trim().min(1).max(50_000).describe('Markdown; @username mentions notify'),
    replyTo: z.uuid().optional().describe('Id of the comment to reply to'),
  }),
  list_agents: z.object({}),
  assign_to_agent: z.object({
    issue,
    agent: ref('The agent: username, name or id (see list_agents)'),
    note: z
      .string()
      .trim()
      .min(1)
      .max(50_000)
      .optional()
      .describe('Markdown, posted as a comment first so the agent reads it'),
  }),
  agent_runs: z.object({ issue }),
  list_agent_runs: z.object({
    agent: ref('Only this agent: username, name or id').optional(),
    status: z
      .enum(['active', 'open', 'finished', 'all'])
      .default('active')
      .describe(
        'active: queued, working or waiting for an answer (default); open: active plus failed runs nobody has restarted or dismissed; finished; or all',
      ),
    limit: limit(200, 50),
  }),
  rerun_agent: z.object({
    issue,
    note: z
      .string()
      .trim()
      .min(1)
      .max(50_000)
      .optional()
      .describe('Markdown, posted as a comment first so the agent reads it'),
  }),
  cancel_agent_run: z.object({ issue }),
  restart_agent_run: failedRun,
  dismiss_agent_run: failedRun,
  current_run: z.object({}),
  report_run: z.object({
    run: z.uuid().optional().describe('The run (default: your only open run)'),
    status: z.enum(['running', 'succeeded', 'failed']).optional(),
    sessionUrl: z.url().max(2000).optional().describe('A link to where the work can be followed'),
    summary: z
      .string()
      .max(50_000)
      .optional()
      .describe('Markdown; when finishing, it is posted on the issue'),
    error: z.string().max(10_000).optional().describe('Why it failed'),
    resume: z
      .string()
      .max(2000)
      .optional()
      .describe('Anything you need to continue this session later; handed back on the next pickup'),
  }),
  report_progress: z.object({
    step: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('What you are doing now, in a few words (e.g. "Running the tests")'),
    percent: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('A rough estimate of how far along you are, if you can tell'),
    run: z.uuid().optional().describe('The run (default: your only open run)'),
  }),
  ask_question: z.object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .describe('Markdown; posted on the issue, mentioning whoever asked for the work'),
    run: z.uuid().optional().describe('The run (default: your only open run)'),
  }),
};

export type McpToolName = keyof typeof mcpToolSchemas;
export type McpToolArgs<T extends McpToolName> = z.infer<(typeof mcpToolSchemas)[T]>;

/** Name, purpose and effect of every tool; the settings page lists them too. */
export const MCP_TOOLS: {
  name: McpToolName;
  title: string;
  description: string;
  readOnly: boolean;
  /** `agent`: only listed for an agent's key (it is about the agent's own runs). */
  audience?: 'agent';
}[] = [
  {
    name: 'list_teams',
    title: 'List teams',
    description: 'Teams you can access, with their keys and workflow statuses.',
    readOnly: true,
  },
  {
    name: 'list_statuses',
    title: 'List statuses',
    description: "A team's workflow statuses in order, with their type.",
    readOnly: true,
  },
  {
    name: 'list_members',
    title: 'List members',
    description: 'People in the workspace: name, username and role.',
    readOnly: true,
  },
  {
    name: 'list_labels',
    title: 'List labels',
    description: 'Workspace labels and team labels.',
    readOnly: true,
  },
  {
    name: 'list_custom_fields',
    title: 'List custom fields',
    description:
      "Custom fields issues can have (workspace-wide or a team's), with their type and options. Set them with customFields on create_issue and update_issue.",
    readOnly: true,
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Projects with status, lead, teams, dates, progress and milestones.',
    readOnly: true,
  },
  {
    name: 'list_cycles',
    title: 'List cycles',
    description: 'Current and upcoming cycles (sprints) per team.',
    readOnly: true,
  },
  {
    name: 'create_cycle',
    title: 'Create cycle',
    description:
      "Plan a cycle (sprint) for a team: start date, end date (the day after its last day) and an optional name. It gets the team's next cycle number.",
    readOnly: false,
  },
  {
    name: 'update_cycle',
    title: 'Update cycle',
    description: "Change a cycle's dates, name or description.",
    readOnly: false,
  },
  {
    name: 'create_milestone',
    title: 'Create milestone',
    description:
      'Add a milestone to a project, with an optional target date. Put issues in it with update_issue.',
    readOnly: false,
  },
  {
    name: 'update_milestone',
    title: 'Update milestone',
    description: "Change a project milestone's name, target date or description.",
    readOnly: false,
  },
  {
    name: 'search_issues',
    title: 'Search issues',
    description:
      'Find issues by text and filters (team, status, assignee, labels, project, cycle, priority, custom fields). Open issues only unless includeClosed, status or statusType is set.',
    readOnly: true,
  },
  {
    name: 'my_issues',
    title: 'My issues',
    description: 'Open issues assigned to you, most urgent first.',
    readOnly: true,
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'One issue in full: description, comments, sub-issues, relations and links.',
    readOnly: true,
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description:
      'Create an issue in a team. Statuses, labels, people and custom fields are given by name.',
    readOnly: false,
  },
  {
    name: 'update_issue',
    title: 'Update issue',
    description:
      'Change an issue: title, description, status, priority, assignee, labels, project, milestone, cycle, parent, estimate, due date or custom fields.',
    readOnly: false,
  },
  {
    name: 'add_relation',
    title: 'Add relation',
    description:
      'Relate two issues: issue blocks other, is blocked by it, is related to it, or is a duplicate of it (which closes issue). Replaces an earlier relation between the two. Agents wait to work on a blocked issue until its blockers are done.',
    readOnly: false,
  },
  {
    name: 'remove_relation',
    title: 'Remove relation',
    description: 'Remove the relation between two issues.',
    readOnly: false,
  },
  {
    name: 'add_comment',
    title: 'Add comment',
    description: 'Comment on an issue (Markdown, @mentions notify people).',
    readOnly: false,
  },
  {
    name: 'list_agents',
    title: 'List agents',
    description:
      'Agents in the workspace: members that are not people. Assigning an issue to one hands it to its runner.',
    readOnly: true,
  },
  {
    name: 'assign_to_agent',
    title: 'Assign to agent',
    description:
      'Hand an issue to an agent, optionally with a note for it. If the agent already has it, it runs again.',
    readOnly: false,
  },
  {
    name: 'agent_runs',
    title: 'Agent runs',
    description:
      "An issue's agent runs: status, runner, session link, summary or error, and usage (tokens, cost in USD, duration) when the runner reported it, newest first.",
    readOnly: true,
  },
  {
    name: 'list_agent_runs',
    title: 'List agent runs',
    description:
      'What agents are doing across the workspace: active runs (queued, working, waiting for an answer) by default, or finished ones, with each run’s usage (tokens, cost in USD, duration) when reported.',
    readOnly: true,
  },
  {
    name: 'rerun_agent',
    title: 'Run agent again',
    description:
      "Ask the issue's agent to work on it again, optionally with a note (e.g. review feedback).",
    readOnly: false,
  },
  {
    name: 'cancel_agent_run',
    title: 'Cancel agent run',
    description: "Stop the agent's queued or running work on an issue.",
    readOnly: false,
  },
  {
    name: 'restart_agent_run',
    title: 'Restart agent run',
    description:
      "Restart an issue's latest failed or cancelled run (of agent, when several agents' runs failed) as a new run: same agent, issue and trigger. Works for mention runs too.",
    readOnly: false,
  },
  {
    name: 'dismiss_agent_run',
    title: 'Dismiss agent run',
    description:
      "Set an issue's latest failed or cancelled run aside without restarting it, so it leaves the open runs.",
    readOnly: false,
  },
  {
    name: 'current_run',
    title: 'Current run',
    description: 'For agents: the runs you are working on now, with their issues.',
    readOnly: true,
    audience: 'agent',
  },
  {
    name: 'report_run',
    title: 'Report run',
    description:
      'For agents: report on a run you hold. Add a session link, mark it running, or finish it (succeeded or failed) with a summary that is posted on the issue.',
    readOnly: false,
    audience: 'agent',
  },
  {
    name: 'report_progress',
    title: 'Report progress',
    description:
      'For agents: say what you are doing now on a run you hold (a few words, optionally a rough percentage). People see the latest one on the run; it is not posted as a comment. Send one at each new step, not more often.',
    readOnly: false,
    audience: 'agent',
  },
  {
    name: 'ask_question',
    title: 'Ask a question',
    description:
      'For agents: ask a person something you need before you can continue, then stop. The question is posted on the issue, the run pauses, and it resumes when someone replies.',
    readOnly: false,
    audience: 'agent',
  },
];
