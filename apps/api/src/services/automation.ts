import { AVATAR_COLORS } from '@ordo/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { teams, users } from '../db/schema.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import type { Ctx } from './context.ts';
import { archiveClosedIssues } from './issues.ts';

/**
 * The workspace's "Ordo" bot, created on first use. Automations (cycles, archiving) act as it, so
 * history reads "Ordo moved this to Cycle 4" rather than naming a person.
 */
export async function automationBot(db: DbOrTx, workspaceId: string): Promise<string> {
  const email = `automation-${workspaceId}@bots.ordo.invalid`;
  const [found] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), eq(users.kind, 'bot')));
  if (found) return found.id;
  const [bot] = await db
    .insert(users)
    .values({
      kind: 'bot',
      botWorkspaceId: workspaceId,
      email,
      name: 'Ordo',
      username: `ordo-${workspaceId.slice(0, 8)}`,
      passwordHash: null,
      avatarColor: AVATAR_COLORS[0]!,
    })
    .onConflictDoNothing()
    .returning({ id: users.id });
  return bot?.id ?? automationBot(db, workspaceId);
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

/** Hourly: archives closed issues in teams that ask for it, after their chosen number of months. */
export async function autoArchive(app: FastifyInstance) {
  const rows = await app.db
    .select({ id: teams.id, workspaceId: teams.workspaceId, months: teams.autoArchiveMonths })
    .from(teams)
    .where(isNotNull(teams.autoArchiveMonths));
  for (const team of rows) {
    await runAutomation(app, team.workspaceId, (ctx) =>
      archiveClosedIssues(ctx, team.id, team.months!),
    );
  }
}
