import type { Cycle } from '@ordo/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { cycles, teams } from '../db/schema.ts';
import { progressBy } from './progress.ts';
import { toCycle } from './serialize.ts';

export async function listCycles(db: DbOrTx, workspaceId: string): Promise<Cycle[]> {
  const teamIds = (
    await db.select({ id: teams.id }).from(teams).where(eq(teams.workspaceId, workspaceId))
  ).map((t) => t.id);
  if (teamIds.length === 0) return [];
  const [rows, progress] = await Promise.all([
    db.select().from(cycles).where(inArray(cycles.teamId, teamIds)).orderBy(asc(cycles.startsAt)),
    progressBy(db, 'cycle_id', workspaceId),
  ]);
  return rows.map((c) => toCycle(c, progress.get(c.id)));
}
