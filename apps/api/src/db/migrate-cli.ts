import { loadEnv } from '../env.ts';
import { createDb } from './client.ts';
import { runMigrations } from './migrate.ts';

const { db, sql } = createDb(loadEnv().databaseUrl);
await runMigrations(db);
await sql.end();
console.log('Migrations applied.');
