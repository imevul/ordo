import { createHash } from 'node:crypto';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const api = process.env.ORDO_API_URL ?? 'http://localhost:3001';

/**
 * Lists every built file in precache.json, so the service worker can fetch them all when it
 * installs: the app then starts offline, on any page, not just on the ones visited before.
 */
const precache: Plugin = {
  name: 'ordo-precache',
  apply: 'build',
  generateBundle(_options, bundle) {
    const files = Object.keys(bundle)
      .filter((f) => f.startsWith('assets/') && !f.endsWith('.map'))
      .sort()
      .map((f) => `/${f}`);
    const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
    this.emitFile({
      type: 'asset',
      fileName: 'precache.json',
      source: JSON.stringify({ version, files }),
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), precache],
  server: {
    port: 5173,
    proxy: {
      '/api/ws': { target: api.replace(/^http/, 'ws'), ws: true },
      '/api': { target: api, changeOrigin: false },
      '/.well-known/oauth-': { target: api, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
