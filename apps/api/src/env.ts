import { readFileSync } from 'node:fs';

function bool(v: string | undefined, fallback: boolean) {
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
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

export interface Env {
  databaseUrl: string;
  host: string;
  port: number;
  publicUrl: string;
  signupMode: 'open' | 'invite';
  allowWorkspaceCreation: boolean;
  logLevel: string;
  /** Directory with the built web client. Served as the SPA when set. */
  staticDir: string | null;
  secureCookies: boolean;
  /** Trust X-Forwarded-* headers (client IP for rate limits). Turn off when Ordo is exposed directly. */
  trustProxy: boolean;
  production: boolean;
  version: string;
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const publicUrl = process.env.ORDO_PUBLIC_URL ?? 'http://localhost:3000';
  const env: Env = {
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://ordo:ordo@localhost:5433/ordo',
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 3001),
    publicUrl: publicUrl.replace(/\/$/, ''),
    signupMode: process.env.ORDO_SIGNUP_MODE === 'open' ? 'open' : 'invite',
    allowWorkspaceCreation: bool(process.env.ORDO_ALLOW_WORKSPACE_CREATION, true),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    staticDir: process.env.ORDO_STATIC_DIR || null,
    secureCookies: bool(process.env.ORDO_SECURE_COOKIES, publicUrl.startsWith('https://')),
    trustProxy: bool(process.env.ORDO_TRUST_PROXY, true),
    production: process.env.NODE_ENV === 'production',
    version: process.env.ORDO_VERSION ?? readVersion(),
  };
  return { ...env, ...overrides };
}
