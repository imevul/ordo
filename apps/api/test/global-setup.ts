import postgres from 'postgres';

/** Recreates the `ordo_test` database on the dev Postgres before the suite runs. */
export default async function setup() {
  const adminUrl =
    process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://ordo:ordo@localhost:5433/ordo';
  const testUrl = new URL(adminUrl);
  testUrl.pathname = '/ordo_test';
  process.env.TEST_DATABASE_URL = testUrl.toString();
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await sql.unsafe('drop database if exists ordo_test with (force)');
  await sql.unsafe('create database ordo_test');
  await sql.end();
}
