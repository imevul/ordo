import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

/** Compose passes `DATABASE_POOL_SIZE` through empty when unset, so empty or invalid means the default. */
export function poolSize(v: string | undefined) {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export function createDb(url: string) {
  const sql = postgres(url, {
    max: poolSize(process.env.DATABASE_POOL_SIZE),
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export { schema };
