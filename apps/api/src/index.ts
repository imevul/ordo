import { buildApp } from './app.ts';
import { runMigrations } from './db/migrate.ts';
import { loadEnv } from './env.ts';

const env = loadEnv();
const app = await buildApp(env);

try {
  await runMigrations(app.db);
  await app.settings.start();
  await app.realtime.start();
  await app.jobs.start();
  app.connectors.start();
  await app.listen({ host: env.host, port: env.port });
  app.log.info(`Ordo ${env.version} ready on ${env.publicUrl}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
