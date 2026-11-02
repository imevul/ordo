import {
  AGENT_RUN_PERSON_REASONS,
  AGENT_RUN_WAIT_REASONS,
  type AgentRunWaitReason,
  filterValues,
} from '@ordo/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import type { Access } from './access.ts';
import { workspaceToday } from './cycle-automation.ts';
import { heldCycles } from './cycles.ts';
import { fullRepositories, issueRepositoryIds } from './repositories.ts';

/**
 * What a run is waiting on, as SQL: one definition of each reason, shared by what a runner may
 * claim, filters and what the run lists say. Everything is correlated on "agent_runs" by name, as
 * the selects these go in leave their columns unqualified. Inside a subquery that selects from
 * agent_runs, that name is the subquery's row.
 */

/** No newer run of the same agent on the same issue: nobody restarted or re-ran it since. */
export const notSuperseded = sql`not exists (select 1 from agent_runs later where later.issue_id = "agent_runs"."issue_id" and later.agent_id = "agent_runs"."agent_id" and (later.created_at, later.id) > ("agent_runs"."created_at", "agent_runs"."id"))`;

/** True while an open issue (not done, cancelled or trashed) blocks the run's issue. */
export const blockedNow = sql`exists (
  select 1 from issue_relations r
  join issues b on b.id = r.issue_id
  join workflow_states s on s.id = b.state_id
  where r.related_issue_id = "agent_runs"."issue_id" and r.type = 'blocks'
    and b.deleted_at is null and s.type not in ('completed', 'canceled')
)`;

/**
 * True while this run is held for its issue's cycle, one of `held` (see `heldCycles`). Only work
 * that hasn't begun waits for its cycle: an issue already started carries on through hand-offs and
 * lapsed leases, and a mention, Run again or a pull request asks for the agent now.
 */
export function heldByCycle(held: Iterable<string>): SQL {
  const ids = [...held];
  if (!ids.length) return sql`false`;
  return sql`("agent_runs"."status" = 'queued'
    and not "agent_runs"."ignore_blockers"
    and "agent_runs"."trigger" in ('assigned', 'scheduled')
    and exists (select 1 from agents a where a.user_id = "agent_runs"."agent_id" and a.wait_for_cycle)
    and exists (
      select 1 from issues i join workflow_states s on s.id = i.state_id
      where i.id = "agent_runs"."issue_id"
        and s.type in ('triage', 'backlog', 'unstarted')
        and i.cycle_id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
    ))`;
}

/** The run's repository is one of these, which are at their run limit. */
export function inFullRepository(full: string[]): SQL {
  if (!full.length) return sql`false`;
  return sql`exists (select 1 from (${issueRepositoryIds(sql`"agent_runs"."issue_id"`)}) repo where repo.repository_id in (${sql.join(
    full.map((id) => sql`${id}`),
    sql`, `,
  )}))`;
}

/** What some reasons need to know that SQL can't say by itself. */
export interface RunHolds {
  heldCycleIds: string[];
  fullRepositoryIds: string[];
}

export async function loadRunHolds(db: DbOrTx, access: Access): Promise<RunHolds> {
  const [held, full] = await Promise.all([
    heldCycles(db, access.workspaceId, await workspaceToday(db, access.workspaceId)),
    fullRepositories(db, access.workspaceId),
  ]);
  return { heldCycleIds: [...held.keys()], fullRepositoryIds: full.map((r) => r.id) };
}

/** The holds a filter needs, when it does: only "waiting on" a named reason reads them. */
export async function runHoldsFor(db: DbOrTx, access: Access, filter: object) {
  return filterValues(filter, 'agentRunWaitingOn').length ? loadRunHolds(db, access) : undefined;
}

const queued = sql`"agent_runs"."status" = 'queued'`;
const waiting = sql`"agent_runs"."status" = 'waiting'`;
/** Failed, and nobody restarted, re-ran or dismissed it. */
const unhandled = sql`("agent_runs"."status" = 'failed' and "agent_runs"."dismissed_at" is null and ${notSuperseded})`;
const askedPermission = sql`(${waiting} and "agent_runs"."question" is not null and "agent_runs"."question_kind" = 'permission')`;
const failedOnPermission = sql`(${unhandled} and "agent_runs"."retry_at" is null and "agent_runs"."failure_reason" = 'permission')`;

/** Waiting on anything at all. Every queued run is, since the last reason is the runner. */
export const runIsWaiting = sql`("agent_runs"."status" in ('queued', 'waiting') or ${unhandled})`;

/** One condition per reason. Needs `holds` for the ones SQL can't work out alone. */
function reasonConditions(holds: RunHolds | undefined): Record<AgentRunWaitReason, SQL> {
  const required = () => {
    // A caller that takes a user's filter loads them with `runHoldsFor`; a miss is a bug, not a
    // filter that should quietly match nothing.
    if (!holds) throw new Error('This filter needs the run holds');
    return holds;
  };
  const blocker = sql`(${queued} and not "agent_runs"."ignore_blockers" and exists (select 1 from agents a where a.user_id = "agent_runs"."agent_id" and a.wait_for_blockers) and ${blockedNow})`;
  const agentPaused = sql`(${queued} and exists (select 1 from agents a where a.user_id = "agent_runs"."agent_id" and a.paused_until > now()))`;
  const runsPaused = sql`(${queued} and exists (select 1 from workspaces w where w.id = "agent_runs"."workspace_id" and (w.settings->>'agentRunsPaused')::boolean))`;
  const agentBusy = sql`(${queued} and (
    exists (select 1 from agent_runs busy where busy.issue_id = "agent_runs"."issue_id" and busy.agent_id = "agent_runs"."agent_id" and busy.status in ('claimed', 'running'))
    or (select count(*) from agent_runs busy where busy.agent_id = "agent_runs"."agent_id" and busy.status in ('claimed', 'running')) >= (select a.concurrency from agents a where a.user_id = "agent_runs"."agent_id")
  ))`;
  return {
    question: sql`(${waiting} and "agent_runs"."question" is not null and "agent_runs"."question_kind" is distinct from 'permission')`,
    plan: sql`(${waiting} and "agent_runs"."plan" is not null and "agent_runs"."plan_approved_at" is null and "agent_runs"."question" is null)`,
    permission: sql`(${askedPermission} or ${failedOnPermission})`,
    failure: sql`(${unhandled} and "agent_runs"."retry_at" is null and "agent_runs"."failure_reason" is distinct from 'permission')`,
    blocker,
    get cycle() {
      return heldByCycle(required().heldCycleIds);
    },
    limit_reset: sql`(${unhandled} and "agent_runs"."retry_at" is not null)`,
    agent_paused: agentPaused,
    runs_paused: runsPaused,
    get repository() {
      return sql`(${queued} and ${inFullRepository(required().fullRepositoryIds)})`;
    },
    agent_busy: agentBusy,
    get runner() {
      const { heldCycleIds, fullRepositoryIds } = required();
      return sql`(${queued} and not ${blocker} and not ${heldByCycle(heldCycleIds)} and not ${agentPaused} and not ${runsPaused} and not ${inFullRepository(fullRepositoryIds)} and not ${agentBusy})`;
    },
  };
}

/** The run waits on any of `reasons`; `person` is any reason a person has to act on. */
export function waitingOn(reasons: (AgentRunWaitReason | 'person')[], holds?: RunHolds): SQL {
  const all = reasonConditions(holds);
  const wanted = new Set(
    reasons.flatMap((r) => (r === 'person' ? [...AGENT_RUN_PERSON_REASONS] : [r])),
  );
  return sql`(${sql.join(
    [...wanted].map((r) => all[r]),
    sql` or `,
  )})`;
}

/**
 * The person a run asks: whoever requested it, else its issue's creator, if human. The same rule
 * as who a question mentions (`humanUsername`). Agents and deleted users don't count.
 */
const askedPerson = sql`coalesce(
  (select u.id from users u where u.id = "agent_runs"."requested_by_id" and u.kind = 'human'),
  (select u.id from issues i join users u on u.id = i.creator_id where i.id = "agent_runs"."issue_id" and u.kind = 'human')
)`;

const needsPerson = () => {
  const all = reasonConditions(undefined);
  return sql`(${sql.join(
    AGENT_RUN_PERSON_REASONS.map((r) => all[r]),
    sql` or `,
  )})`;
};

/** A person must act on the run, and it's one of `people`. */
export function waitingFor(people: string[]): SQL {
  return sql`(${needsPerson()} and ${askedPerson} in (${sql.join(
    people.map((id) => sql`${id}`),
    sql`, `,
  )}))`;
}

/** The person a run is waiting for, as a column. Null when it needn't, or there's nobody to ask. */
export const waitingForIdColumn = () =>
  sql<string | null>`case when ${needsPerson()} then ${askedPerson} end`;

/** A run's reasons, as a column. Built from the same conditions the filters use. */
export function waitReasonsColumn(holds: RunHolds) {
  const all = reasonConditions(holds);
  const cases = AGENT_RUN_WAIT_REASONS.map((r) => sql`case when ${all[r]} then ${r} end`);
  return sql<AgentRunWaitReason[]>`array_remove(array[${sql.join(cases, sql`, `)}]::text[], null)`;
}
