import { AVATAR_COLORS } from '@ordo/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DbOrTx } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { runInWorkspace } from '../lib/mutate.ts';
import type { Ctx } from './context.ts';

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

/** Runs an automation in one workspace, as its bot, without notifying anyone. */
export async function runAutomation<T>(
  app: FastifyInstance,
  workspaceId: string,
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  const actorId = await automationBot(app.db, workspaceId);
  return runInWorkspace(app, { workspaceId, actorId, source: 'system', silent: true }, fn);
}
