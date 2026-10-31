import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Config {
  url?: string;
  token?: string;
  /** The workspace commands use unless told otherwise. */
  workspace?: string;
}

export function configPath(env: Record<string, string | undefined>) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'ordo', 'config.json');
}

export async function readConfig(path: string): Promise<Config> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Config;
  } catch {
    return {};
  }
}

/**
 * The file holds an API key, so only its owner may read it. `mode` only applies when a file is
 * created, so an existing one is chmod'ed too, before the key goes in.
 */
export async function writeConfig(path: string, config: Config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, '', { mode: 0o600, flag: 'a' });
  await chmod(path, 0o600);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export const removeConfig = (path: string) => rm(path, { force: true });

/** The environment wins over the file, so scripts and CI need no `ordo login`. */
export function effectiveConfig(file: Config, env: Record<string, string | undefined>): Config {
  return {
    url: env.ORDO_URL || file.url,
    token: env.ORDO_TOKEN || file.token,
    workspace: env.ORDO_WORKSPACE || file.workspace,
  };
}
