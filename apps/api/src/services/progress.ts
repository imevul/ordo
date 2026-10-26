import type { Progress } from '@ordo/shared';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import type { Access } from './access.ts';

export const emptyProgress = (): Progress => ({
  total: 0,
  completed: 0,
  started: 0,
  canceled: 0,
  totalEstimate: 0,
  completedEstimate: 0,
});

/** Issue counts per project or cycle, keyed by its id — counting only issues the viewer can see. */
export async function progressBy(
  db: DbOrTx,
  column: 'project_id' | 'cycle_id',
  access: Access,
): Promise<Map<string, Progress>> {
  const col = sql.raw(`i.${column}`);
  const workspaceId = access.workspaceId;
  const scope = access.isAdmin
    ? sql``
    : access.teamIds.length
      ? sql` and i.team_id in (${sql.join(
          access.teamIds.map((t) => sql`${t}`),
          sql`, `,
        )})`
      : sql` and false`;
  const rows = await db.execute<{ key: string; type: string; n: number; est: number }>(sql`
    select ${col} as key, s.type, count(*)::int as n, coalesce(sum(i.estimate), 0)::int as est
    from issues i join workflow_states s on s.id = i.state_id
    where i.workspace_id = ${workspaceId} and i.deleted_at is null and ${col} is not null${scope}
    group by 1, 2`);
  const map = new Map<string, Progress>();
  for (const r of rows) {
    const p = map.get(r.key) ?? emptyProgress();
    p.total += r.n;
    p.totalEstimate += r.est;
    if (r.type === 'completed') {
      p.completed += r.n;
      p.completedEstimate += r.est;
    } else if (r.type === 'started') p.started += r.n;
    else if (r.type === 'canceled') p.canceled += r.n;
    map.set(r.key, p);
  }
  return map;
}
