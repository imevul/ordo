import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Keeps what the API reads, docs/configuration.md, docker-compose.yml and .env.example in sync, so a
// documented setting can't silently do nothing in a Compose install.

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Overrides that point integrations at the mock servers in tests; not for operators. */
const TEST_HOOKS = [
  'ORDO_DISCORD_API_URL',
  'ORDO_LINEAR_API_URL',
  'ORDO_SLACK_API_URL',
  'ORDO_TELEGRAM_API_URL',
];

/** Set by the Dockerfile or only used outside the image (dev, seeding). */
const NOT_IN_COMPOSE = [
  'HOST',
  'PORT',
  'NODE_ENV',
  'ORDO_STATIC_DIR',
  'ORDO_MIGRATIONS_DIR',
  'ORDO_DATA_DIR',
  'ORDO_SECURE_COOKIES',
  'SEED_PASSWORD',
];

function sourceVars() {
  const dir = join(root, 'apps/api/src');
  const vars = new Set<string>();
  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) continue;
    for (const m of readFileSync(join(dir, file), 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g))
      vars.add(m[1]!);
  }
  return vars;
}

/** Variables named in the first column of the tables in docs/configuration.md. */
function documentedVars() {
  const vars = new Set<string>();
  for (const line of read('docs/configuration.md').split('\n')) {
    const cell = line.match(/^\|([^|]+)\|/)?.[1];
    if (!cell) continue;
    for (const m of cell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) vars.add(m[1]!);
  }
  return vars;
}

const compose = read('docker-compose.yml');

/** What compose reads from `.env`: `${VAR…}` interpolations and bare pass-throughs (`HTTP_PROXY:`). */
function composeInputs() {
  const vars = new Set<string>();
  for (const m of compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) vars.add(m[1]!);
  for (const m of compose.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*$/gm)) vars.add(m[1]!);
  for (const m of compose.matchAll(/^\s+- ([A-Z][A-Z0-9_]*)\s*$/gm)) vars.add(m[1]!);
  return vars;
}

/** What compose handles: its inputs plus variables it sets itself (`DATABASE_URL: postgres://…`). */
function composeVars() {
  const vars = composeInputs();
  for (const m of compose.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)) vars.add(m[1]!);
  return vars;
}

function envExampleVars() {
  const vars = new Set<string>();
  for (const m of read('.env.example').matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)) vars.add(m[1]!);
  return vars;
}

const missing = (from: Iterable<string>, inSet: Set<string>, except: string[] = []) =>
  [...from].filter((v) => !inSet.has(v) && !except.includes(v)).sort();

describe('configuration', () => {
  it('documents every variable the API reads', () => {
    expect(missing(sourceVars(), documentedVars(), TEST_HOOKS)).toEqual([]);
  });

  it('passes every documented variable through docker-compose.yml', () => {
    expect(missing(documentedVars(), composeVars(), NOT_IN_COMPOSE)).toEqual([]);
  });

  it('lists every variable docker-compose.yml uses in .env.example', () => {
    expect(missing(composeInputs(), envExampleVars())).toEqual([]);
  });

  it('keeps the lists of exceptions current', () => {
    const src = sourceVars();
    const docs = documentedVars();
    expect(TEST_HOOKS.filter((v) => !src.has(v) || docs.has(v))).toEqual([]);
    expect(NOT_IN_COMPOSE.filter((v) => !docs.has(v) || composeVars().has(v))).toEqual([]);
  });
});
