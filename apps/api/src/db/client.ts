import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDb(url: string) {
  const sql = postgres(url, {
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export { schema };
