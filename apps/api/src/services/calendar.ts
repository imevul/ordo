import type { CalendarFeed, IssueFilter } from '@ordo/shared';
import { and, asc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import {
  calendarFeeds,
  cycles,
  issues,
  projectMilestones,
  projects,
  projectTeams,
  teams,
  views,
  workflowStates,
} from '../db/schema.ts';
import { authorizeWorkspace, signInUser } from '../lib/auth.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { type Access, canReadTeam } from './access.ts';
import { filterConditions } from './issues.ts';

/** Feed tokens are recognisable in logs and leaked-secret scanners, like API keys. */
export const CALENDAR_TOKEN_PREFIX = 'ordo_cal_';
/** How far back the personal feed shows cycles; older ones only clutter a calendar. */
const CYCLE_HISTORY_DAYS = 180;
const MAX_ISSUES = 2000;

export const newCalendarToken = () => `${CALENDAR_TOKEN_PREFIX}${randomToken(24)}`;
export const calendarFeedUrl = (app: FastifyInstance, token: string) =>
  `${app.env.publicUrl}/api/calendar/${token}.ics`;

export function toCalendarFeed(row: typeof calendarFeeds.$inferSelect): CalendarFeed {
  return {
    id: row.id,
    viewId: row.viewId,
    prefix: row.prefix,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/** A saved view the user can see: shared, or their own. */
export async function visibleView(db: DbOrTx, access: Access, viewId: string) {
  const [view] = await db
    .select()
    .from(views)
    .where(
      and(
        eq(views.id, viewId),
        eq(views.workspaceId, access.workspaceId),
        or(eq(views.shared, true), eq(views.ownerId, access.userId)),
      ),
    );
  if (!view) throw notFound('View');
  return view;
}

// --- iCalendar (RFC 5545) ---------------------------------------------------------------------

/** An all-day event: `date` to `endDate` (inclusive), both `YYYY-MM-DD`. */
export interface CalendarEvent {
  uid: string;
  date: string;
  endDate?: string;
  summary: string;
  description?: string;
  url?: string;
}

export const escapeText = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n|\r/g, '\\n');

/** Folds a content line to 75 octets per line, never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    // Continuation lines start with a space, which counts toward their 75.
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

const icsDate = (d: string) => d.replaceAll('-', '');
export function nextDay(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

export function renderCalendar(name: string, events: CalendarEvent[], now = new Date()): string {
  const stamp = `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ordo//Calendar feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    // Hints only; Google Calendar ignores them and polls on its own schedule.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(e.date)}`,
      // DTEND is exclusive for all-day events.
      `DTEND;VALUE=DATE:${icsDate(nextDay(e.endDate ?? e.date))}`,
      `SUMMARY:${escapeText(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

// --- Feed contents ----------------------------------------------------------------------------

interface FeedScope {
  app: FastifyInstance;
  access: Access;
  slug: string;
  /** Unique per instance, so the same issue in two feeds doesn't clash in one calendar app. */
  host: string;
}

async function issueEvents(s: FeedScope, filter: IssueFilter): Promise<CalendarEvent[]> {
  const rows = await s.app.db
    .select({
      id: issues.id,
      number: issues.number,
      title: issues.title,
      dueDate: issues.dueDate,
      key: teams.key,
      state: workflowStates.name,
    })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .where(and(...filterConditions(s.access, filter), isNotNull(issues.dueDate)))
    .orderBy(asc(issues.dueDate))
    .limit(MAX_ISSUES);
  return rows.map((r) => {
    const identifier = `${r.key}-${r.number}`;
    return {
      uid: `issue-${r.id}@${s.host}`,
      date: r.dueDate!,
      summary: `${identifier} ${r.title}`,
      description: r.state,
      url: `${s.app.env.publicUrl}/${s.slug}/issue/${identifier}`,
    };
  });
}

/** Cycles of the teams the user has joined (and can still read). */
async function cycleEvents(s: FeedScope): Promise<CalendarEvent[]> {
  const teamIds = s.access.memberTeamIds.filter((id) => canReadTeam(s.access, id));
  if (teamIds.length === 0) return [];
  const since = new Date(Date.now() - CYCLE_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await s.app.db
    .select({
      id: cycles.id,
      number: cycles.number,
      name: cycles.name,
      startsAt: cycles.startsAt,
      endsAt: cycles.endsAt,
      key: teams.key,
    })
    .from(cycles)
    .innerJoin(teams, eq(teams.id, cycles.teamId))
    .where(
      and(
        inArray(cycles.teamId, teamIds),
        eq(teams.workspaceId, s.access.workspaceId),
        gte(cycles.endsAt, since),
      ),
    )
    .orderBy(asc(cycles.startsAt));
  return rows.map((c) => ({
    uid: `cycle-${c.id}@${s.host}`,
    date: c.startsAt,
    endDate: c.endsAt,
    summary: `${c.key} Cycle ${c.number}${c.name ? `: ${c.name}` : ''}`,
    url: `${s.app.env.publicUrl}/${s.slug}/team/${c.key}/cycle/${c.number}`,
  }));
}

/** Milestones with a target date, of open projects of the teams the user has joined. */
async function milestoneEvents(s: FeedScope): Promise<CalendarEvent[]> {
  const teamIds = s.access.memberTeamIds.filter((id) => canReadTeam(s.access, id));
  if (teamIds.length === 0) return [];
  const rows = await s.app.db
    .select({
      id: projectMilestones.id,
      name: projectMilestones.name,
      targetDate: projectMilestones.targetDate,
      projectId: projects.id,
      project: projects.name,
    })
    .from(projectMilestones)
    .innerJoin(projects, eq(projects.id, projectMilestones.projectId))
    .where(
      and(
        eq(projects.workspaceId, s.access.workspaceId),
        notInArray(projects.status, ['completed', 'canceled']),
        isNotNull(projectMilestones.targetDate),
        sql`exists (select 1 from ${projectTeams} pt where pt.project_id = "projects"."id" and pt.team_id in (${sql.join(
          teamIds.map((id) => sql`${id}`),
          sql`, `,
        )}))`,
      ),
    )
    .orderBy(asc(projectMilestones.targetDate));
  return rows.map((m) => ({
    uid: `milestone-${m.id}@${s.host}`,
    date: m.targetDate!,
    summary: `${m.project}: ${m.name}`,
    url: `${s.app.env.publicUrl}/${s.slug}/project/${m.projectId}`,
  }));
}

const OPEN_STATES: IssueFilter['stateTypes'] = ['triage', 'backlog', 'unstarted', 'started'];

/**
 * The `.ics` body for a feed token, built with the owner's access as it is now: a disabled
 * account, a suspended or removed member, a lost team or a hidden view all show up here.
 * Throws "not found" for every token that doesn't (or no longer) work, so none leak.
 */
export async function calendarForToken(app: FastifyInstance, token: string): Promise<string> {
  const gone = () => notFound('Calendar');
  if (!token.startsWith(CALENDAR_TOKEN_PREFIX)) throw gone();
  const [feed] = await app.db
    .select()
    .from(calendarFeeds)
    .where(eq(calendarFeeds.tokenHash, sha256(token)));
  if (!feed) throw gone();
  const user = await signInUser(app.db, feed.userId);
  if (!user) throw gone();
  let ws: Awaited<ReturnType<typeof authorizeWorkspace>>;
  try {
    // Feeds are long-lived bearer secrets, so require-SSO treats them like API keys.
    ws = await authorizeWorkspace(
      app.db,
      user,
      { id: feed.workspaceId },
      {
        method: 'api_key',
        sso: null,
      },
    );
  } catch (err) {
    if (err instanceof HttpError) throw gone();
    throw err;
  }
  const s: FeedScope = {
    app,
    access: ws.access,
    slug: ws.slug,
    host: new URL(app.env.publicUrl).host,
  };

  let name: string;
  let events: CalendarEvent[];
  if (feed.viewId) {
    const view = await visibleView(app.db, ws.access, feed.viewId).catch(() => null);
    if (!view) throw gone();
    name = `${view.name} · ${ws.name}`;
    events = await issueEvents(s, {
      ...view.filters,
      teamId: view.filters.teamId ?? view.teamId ?? undefined,
    });
  } else {
    name = `Ordo · ${ws.name}`;
    const [mine, cycleList, milestones] = await Promise.all([
      issueEvents(s, { assigneeIds: ['me'], stateTypes: OPEN_STATES }),
      cycleEvents(s),
      milestoneEvents(s),
    ]);
    events = [...mine, ...cycleList, ...milestones];
  }

  // Calendar apps poll often; last-used is a hint, so write it at most every few minutes.
  const now = Date.now();
  if (!feed.lastUsedAt || now - new Date(feed.lastUsedAt).getTime() > 5 * 60_000)
    app.db
      .update(calendarFeeds)
      .set({ lastUsedAt: new Date(now).toISOString() })
      .where(eq(calendarFeeds.id, feed.id))
      .catch(() => {});
  return renderCalendar(name, events);
}

/** Removes the user's feeds in a workspace that match `viewId` (null: the personal feed). */
export async function deleteFeedsFor(
  db: DbOrTx,
  userId: string,
  workspaceId: string,
  viewId: string | null,
) {
  return db
    .delete(calendarFeeds)
    .where(
      and(
        eq(calendarFeeds.userId, userId),
        eq(calendarFeeds.workspaceId, workspaceId),
        viewId ? eq(calendarFeeds.viewId, viewId) : isNull(calendarFeeds.viewId),
      ),
    )
    .returning({ id: calendarFeeds.id });
}
