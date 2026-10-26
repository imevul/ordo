import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function bool(v: string | undefined, fallback: boolean) {
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Like `bool`, but `undefined` when unset, so the value can be managed in the admin UI instead. */
function optionalBool(v: string | undefined) {
  return v == null || v === '' ? undefined : bool(v, false);
}

function optionalInt(v: string | undefined) {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
  maxAttachmentMb?: number;
  smtp?: { url: string; from: string } | null;
}

export type StorageConfig =
  | { driver: 'local'; dir: string }
  | {
      driver: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      /** Path-style URLs (endpoint/bucket/key) — what MinIO, Garage and most self-hosted S3 need. */
      forcePathStyle: boolean;
    };

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
  /** Where uploads live. Configured by environment only: switching backends means moving files. */
  storage: StorageConfig;
  /** GitHub for the GitHub App flow; point at GitHub Enterprise Server to use that instead. */
  github: { apiUrl: string; webUrl: string };
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
    github: {
      apiUrl: (process.env.ORDO_GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
      webUrl: (process.env.ORDO_GITHUB_URL || 'https://github.com').replace(/\/$/, ''),
    },
    settingsFromEnv: {
      signupMode: signupMode === 'open' || signupMode === 'invite' ? signupMode : undefined,
      allowWorkspaceCreation: optionalBool(process.env.ORDO_ALLOW_WORKSPACE_CREATION),
      allowPrivateNetworkTargets: optionalBool(process.env.ORDO_ALLOW_PRIVATE_NETWORK_TARGETS),
      smtp: process.env.ORDO_SMTP_URL
        ? {
            url: process.env.ORDO_SMTP_URL,
            from: process.env.ORDO_SMTP_FROM || 'Ordo <ordo@localhost>',
          }
        : undefined,
      maxAttachmentMb: optionalInt(process.env.ORDO_MAX_ATTACHMENT_MB),
    },
    storage:
      process.env.ORDO_STORAGE === 's3'
        ? {
            driver: 's3',
            endpoint: (process.env.ORDO_S3_ENDPOINT ?? 'https://s3.amazonaws.com').replace(
              /\/$/,
              '',
            ),
            region: process.env.ORDO_S3_REGION ?? 'us-east-1',
            bucket: process.env.ORDO_S3_BUCKET ?? 'ordo',
            accessKeyId: process.env.ORDO_S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: process.env.ORDO_S3_SECRET_ACCESS_KEY ?? '',
            forcePathStyle: bool(process.env.ORDO_S3_FORCE_PATH_STYLE, true),
          }
        : { driver: 'local', dir: resolve(process.env.ORDO_DATA_DIR ?? 'data', 'uploads') },
  };
  return { ...env, ...overrides };
}
