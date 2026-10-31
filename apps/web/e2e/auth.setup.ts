import { expect, test } from '@playwright/test';
import { DEMO } from './fixtures.ts';
import { STATE } from './playwright.config.ts';

// One sign-in for every spec (the sign-in limit is per address and minute); sign-in.e2e.ts goes
// through the form itself.
test('sign in as the demo admin', async ({ request }) => {
  const res = await request.post('/api/auth/login', { data: DEMO });
  expect(res.ok()).toBe(true);
  await request.storageState({ path: STATE });
});
