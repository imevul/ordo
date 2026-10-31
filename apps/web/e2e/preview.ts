import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Starts `scripts/dev-preview.sh` and waits for its "ready" line, so the tests get their own
 * seeded database and ports. With E2E_BASE_URL set (a preview or `pnpm dev` already running),
 * it uses that instead.
 */
export default async function preview() {
  if (process.env.E2E_BASE_URL) return;
  const root = join(import.meta.dirname, '../../..');
  const child = spawn('bash', ['scripts/dev-preview.sh', '--ttl', '1h'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Preview didn't start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk;
      const ready = output.match(/Ordo preview ready: (\S+)/);
      if (ready) {
        clearTimeout(timer);
        resolve(ready[1]!);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Preview exited (${code}):\n${output}`));
    });
  });
  process.env.E2E_BASE_URL = url;
  return async () => {
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    // The script stops its servers and drops its database on the way out.
    child.kill('SIGTERM');
    await stopped;
  };
}
