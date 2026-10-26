// Bundles the API (and the demo seed script) into single ESM files so the runtime image needs no node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: { server: 'src/index.ts', seed: 'src/db/seed.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  // pino-pretty is a dev-only log transport.
  external: ['pino-pretty'],
  // Some CJS dependencies call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
