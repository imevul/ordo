// Bundles the CLI into one dependency-free file that Ordo serves at /cli/ordo.mjs.
import { chmod } from 'node:fs/promises';
import { build } from 'esbuild';

const outfile = 'dist/ordo.mjs';
await build({
  entryPoints: ['src/bin.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});
await chmod(outfile, 0o755);
