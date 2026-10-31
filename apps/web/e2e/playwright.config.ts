import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export const STATE = join(import.meta.dirname, '.auth/demo.json');

/**
 * Browser smoke tests over the flows where UI wiring matters most. `pnpm e2e` starts
 * `pnpm dev:preview` (a throwaway seeded database, free ports) unless E2E_BASE_URL points at one
 * that is already running. Every spec runs at desktop width and at 375px.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: '../test-results',
  globalSetup: './preview.ts',
  fullyParallel: true,
  // The dev server compiles on demand; a cold first page can take a while.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    // Set by preview.ts, which runs before the workers start.
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: 'auth.setup.ts' },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: { viewport: { width: 1280, height: 800 }, storageState: STATE },
    },
    {
      name: 'mobile',
      dependencies: ['setup'],
      use: { viewport: { width: 375, height: 812 }, storageState: STATE },
    },
  ],
});
