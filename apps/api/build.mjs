// Bundles the API (and the demo seed script) into single ESM files so the runtime image needs no node_modules.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

await build({
  entryPoints: { server: 'src/index.ts', seed: 'src/db/seed.ts', cli: 'src/cli.ts' },
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

// Matrix encryption's WebAssembly: the bundled loader reads it from pkg/ next to the bundle.
const crypto = dirname(
  createRequire(import.meta.url).resolve('@matrix-org/matrix-sdk-crypto-wasm'),
);
await mkdir('dist/pkg', { recursive: true });
await copyFile(
  join(crypto, 'pkg/matrix_sdk_crypto_wasm_bg.wasm'),
  'dist/pkg/matrix_sdk_crypto_wasm_bg.wasm',
);
