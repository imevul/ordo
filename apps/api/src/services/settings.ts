import {
  INSTANCE_SETTING_DEFAULTS,
  type InstanceSettingEntry,
  type InstanceSettings,
} from '@ordo/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { instanceSettings } from '../db/schema.ts';
import type { SettingsFromEnv } from '../env.ts';

const CHANNEL = 'ordo_settings';

const SCHEMAS: { [K in keyof InstanceSettings]: z.ZodType<InstanceSettings[K]> } = {
  signupMode: z.enum(['open', 'invite']),
  allowWorkspaceCreation: z.boolean(),
  allowPrivateNetworkTargets: z.boolean(),
};

export const SETTING_KEYS = Object.keys(SCHEMAS) as (keyof InstanceSettings)[];
export const settingSchema = <K extends keyof InstanceSettings>(key: K) => SCHEMAS[key];

/**
 * Instance settings with precedence env → database → default. Values are cached in memory;
 * a NOTIFY on `ordo_settings` makes every instance reload after a change.
 */
export class Settings {
  private stored: Partial<InstanceSettings> = {};

  constructor(
    private db: Db,
    private sql: Sql,
    private fromEnv: SettingsFromEnv,
    private log: FastifyBaseLogger,
  ) {}

  async start() {
    await this.reload();
    try {
      await this.sql.listen(CHANNEL, () => {
        this.reload().catch((err) => this.log.error({ err }, 'reloading settings failed'));
      });
    } catch (err) {
      this.log.error(
        { err },
        'LISTEN for settings failed; changes need a restart on other instances',
      );
    }
  }

  async reload() {
    const rows = await this.db.select().from(instanceSettings);
    const next: Partial<InstanceSettings> = {};
    for (const row of rows) {
      const key = row.key as keyof InstanceSettings;
      const parsed = SCHEMAS[key]?.safeParse(row.value);
      if (parsed?.success) (next as Record<string, unknown>)[key] = parsed.data;
    }
    this.stored = next;
  }

  get<K extends keyof InstanceSettings>(key: K): InstanceSettings[K] {
    return (this.fromEnv[key] ??
      this.stored[key] ??
      INSTANCE_SETTING_DEFAULTS[key]) as InstanceSettings[K];
  }

  describe(): InstanceSettingEntry[] {
    return SETTING_KEYS.map((key) => ({
      key,
      value: this.get(key),
      source:
        this.fromEnv[key] !== undefined ? 'env' : this.stored[key] !== undefined ? 'db' : 'default',
    }));
  }

  isLocked(key: keyof InstanceSettings) {
    return this.fromEnv[key] !== undefined;
  }

  async set<K extends keyof InstanceSettings>(
    key: K,
    value: InstanceSettings[K],
    actorId: string | null,
  ) {
    const parsed = SCHEMAS[key].parse(value);
    await this.db
      .insert(instanceSettings)
      .values({ key, value: parsed, updatedBy: actorId })
      .onConflictDoUpdate({
        target: instanceSettings.key,
        set: { value: parsed, updatedBy: actorId, updatedAt: new Date().toISOString() },
      });
    await this.reload();
    await this.sql.notify(CHANNEL, key).catch(() => {});
  }
}
