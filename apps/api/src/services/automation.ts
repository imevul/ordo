import { AVATAR_COLORS } from '@ordo/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { teams, users } from '../db/schema.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import type { Ctx } from './context.ts';
import { archiveClosedIssues } from './issues.ts';
import { uniqueUsername } from './sso.ts';

/**
 * The workspace's "Ordo" bot, created on first use. Automations (cycles, archiving) act as it, so
 * history reads "Ordo moved this to Cycle 4" rather than naming a person.
 */
export async function automationBot(db: DbOrTx, workspaceId: string): Promise<string> {
  const email = `automation-${workspaceId}@bots.ordo.invalid`;
  // Integration bots share botWorkspaceId and kind, so the email tells this one apart.
  const find = async () => {
    const [found] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.botWorkspaceId, workspaceId), eq(users.kind, 'bot'), eq(users.email, email)),
      );
    return found?.id;
  };
  const existing = await find();
  if (existing) return existing;
  // Anyone can claim `ordo-<id>` before the bot exists, so take the next free name.
  const username = await uniqueUsername(db, `ordo-${workspaceId.slice(0, 8)}`);
  const [bot] = await db
    .insert(users)
    .values({
      kind: 'bot',
      botWorkspaceId: workspaceId,
      email,
      name: 'Ordo',
      username,
      passwordHash: null,
      avatarColor: AVATAR_COLORS[0]!,
    })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (bot) return bot.id;
  // A concurrent first use created it; anything else (the username taken in between, the email
  // held by another account) fails here, once, instead of retrying forever.
  const raced = await find();
  if (raced) return raced;
  throw new Error(`Could not create the automation bot for workspace ${workspaceId}`);
}

/**
 * Runs an automation in one workspace, as its bot. Not silent: webhooks and integrations hear
 * about its changes. (Rolling issues over and archiving don't notify anyone in Ordo anyway.)
 */
export async function runAutomation<T>(
  app: FastifyInstance,
  workspaceId: string,
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  const actorId = await automationBot(app.db, workspaceId);
  return runInWorkspace(app, { workspaceId, actorId, source: 'system' }, fn);
}

/**
 * Runs `fn` for each item of a scheduled sweep (a team, an issue, a schedule). One that fails is
 * logged and skipped, so it can't hold up the rest; the next run tries it again.
 */
export async function forEachIsolated<T>(
  app: FastifyInstance,
  job: string,
  items: T[],
  describe: (item: T) => Record<string, unknown>,
  fn: (item: T) => Promise<unknown>,
) {
  let failed = 0;
  for (const item of items) {
    try {
      await fn(item);
    } catch (err) {
      failed++;
      app.log.error({ err, job, ...describe(item) }, `${job}: one item failed; continuing`);
    }
  }
  return failed;
}

/** Hourly: archives closed issues in teams that ask for it, after their chosen number of months. */
export async function autoArchive(app: FastifyInstance) {
  const rows = await app.db
    .select({ id: teams.id, workspaceId: teams.workspaceId, months: teams.autoArchiveMonths })
    .from(teams)
    .where(isNotNull(teams.autoArchiveMonths));
  await forEachIsolated(
    app,
    'issues.autoArchive',
    rows,
    (team) => ({ teamId: team.id, workspaceId: team.workspaceId }),
    (team) =>
      runAutomation(app, team.workspaceId, (ctx) =>
        archiveClosedIssues(ctx, team.id, team.months!),
      ),
  );
}
