import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function bool(v: string | undefined, fallback: boolean) {
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Like `bool`, but `undefined` when unset, so the value can be managed in the admin UI instead. */
function optionalBool(v: string | undefined) {
  return v == null || v === '' ? undefined : bool(v, false);
}

/** package.json sits next to the bundle in the image, and one level up from src/. */
function readVersion() {
  for (const rel of ['./package.json', '../package.json']) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')).version as string;
    } catch {}
  }
  return '0.0.0';
}

/**
 * Accepts a base64-encoded 32-byte key (what `make` generates). Any other string is hashed
 * into a key, so hand-written passphrases also work.
 */
function parseKey(raw: string | undefined): Buffer | null {
  if (!raw?.trim()) return null;
  const decoded = Buffer.from(raw.trim(), 'base64');
  if (
    decoded.length === 32 &&
    decoded.toString('base64').replace(/=+$/, '') === raw.trim().replace(/=+$/, '')
  ) {
    return decoded;
  }
  return createHash('sha256').update(raw.trim()).digest();
}

/** Instance settings that may be pinned by environment variables (see services/settings.ts). */
export interface SettingsFromEnv {
  signupMode?: 'open' | 'invite';
  allowWorkspaceCreation?: boolean;
  allowPrivateNetworkTargets?: boolean;
}

export interface Env {
  databaseUrl: string;
  host: string;
  port: number;
  publicUrl: string;
  logLevel: string;
  /** Directory with the built web client. Served as the SPA when set. */
  staticDir: string | null;
  secureCookies: boolean;
  /** Trust X-Forwarded-* headers (client IP for rate limits). Turn off when Ordo is exposed directly. */
  trustProxy: boolean;
  production: boolean;
  version: string;
  /** ORDO_SECRET_KEY; encrypts stored secrets. Null means encryption is unavailable. */
  secretKey: Buffer | null;
  /** ORDO_SECRET_KEY_PREVIOUS; still accepted for decryption while rotating keys. */
  previousSecretKey: Buffer | null;
  settingsFromEnv: SettingsFromEnv;
}

// Used only outside production when no key is configured, so dev and tests just work.
const DEV_SECRET_KEY = createHash('sha256').update('ordo-insecure-development-key').digest();

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const publicUrl = process.env.ORDO_PUBLIC_URL ?? 'http://localhost:3000';
  const production = process.env.NODE_ENV === 'production';
  const signupMode = process.env.ORDO_SIGNUP_MODE;
  const env: Env = {
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://ordo:ordo@localhost:5433/ordo',
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 3001),
    publicUrl: publicUrl.replace(/\/$/, ''),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    staticDir: process.env.ORDO_STATIC_DIR || null,
    secureCookies: bool(process.env.ORDO_SECURE_COOKIES, publicUrl.startsWith('https://')),
    trustProxy: bool(process.env.ORDO_TRUST_PROXY, true),
    production,
    version: process.env.ORDO_VERSION ?? readVersion(),
    secretKey: parseKey(process.env.ORDO_SECRET_KEY) ?? (production ? null : DEV_SECRET_KEY),
    previousSecretKey: parseKey(process.env.ORDO_SECRET_KEY_PREVIOUS),
    settingsFromEnv: {
      signupMode: signupMode === 'open' || signupMode === 'invite' ? signupMode : undefined,
      allowWorkspaceCreation: optionalBool(process.env.ORDO_ALLOW_WORKSPACE_CREATION),
      allowPrivateNetworkTargets: optionalBool(process.env.ORDO_ALLOW_PRIVATE_NETWORK_TARGETS),
    },
  };
  return { ...env, ...overrides };
}
