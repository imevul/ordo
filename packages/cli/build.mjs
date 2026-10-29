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
  // Some dependencies (yaml) are CommonJS and require Node built-ins; ESM output needs a `require`.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __ordoRequire } from 'node:module';\nconst require = __ordoRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
await chmod(outfile, 0o755);
