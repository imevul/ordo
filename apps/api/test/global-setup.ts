import postgres from 'postgres';

/**
 * Creates a test database on the dev Postgres for this run, `ordo_test_<pid>`, and drops it (and the
 * extra databases made by `freshDatabase`) afterwards. The name is per run so that test runs in
 * several checkouts at once don't drop each other's database.
 */
export default async function setup() {
  const adminUrl =
    process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://ordo:ordo@localhost:5433/ordo';
  const name = `ordo_test_${process.pid}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  process.env.TEST_DATABASE_URL = testUrl.toString();
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  // Runs that were killed before their teardown leave databases behind; drop those whose process is gone.
  await dropDatabases(sql, (pid) => pid === process.pid || !alive(pid));
  await sql.unsafe(`create database ${name}`);
  await sql.end();

  return async () => {
    const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await dropDatabases(sql, (pid) => pid === process.pid);
    await sql.end();
  };
}

async function dropDatabases(sql: postgres.Sql, match: (pid: number) => boolean) {
  for (const { datname } of await sql<{ datname: string }[]>`select datname from pg_database`) {
    const pid = /^ordo_test_(\d+)(_|$)/.exec(datname)?.[1];
    if (pid && match(Number(pid)))
      await sql.unsafe(`drop database if exists ${datname} with (force)`);
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
