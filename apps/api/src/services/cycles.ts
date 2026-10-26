import type { Cycle } from '@ordo/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { cycles, teams } from '../db/schema.ts';
import { type Access, teamScope } from './access.ts';
import { progressBy } from './progress.ts';
import { toCycle } from './serialize.ts';

/** Cycles of the teams `access` can see. */
export async function listCycles(db: DbOrTx, access: Access): Promise<Cycle[]> {
  const teamIds = (
    await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.workspaceId, access.workspaceId), teamScope(access, teams.id)))
  ).map((t) => t.id);
  if (teamIds.length === 0) return [];
  const [rows, progress] = await Promise.all([
    db.select().from(cycles).where(inArray(cycles.teamId, teamIds)).orderBy(asc(cycles.startsAt)),
    progressBy(db, 'cycle_id', access),
  ]);
  return rows.map((c) => toCycle(c, progress.get(c.id)));
}
