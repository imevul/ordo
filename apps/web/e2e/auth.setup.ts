import { expect, test } from '@playwright/test';
import { DEMO } from './fixtures.ts';
import { STATE } from './playwright.config.ts';

// One sign-in for every spec (the sign-in limit is per address and minute); sign-in.e2e.ts goes
// through the form itself.
test('sign in as the demo admin', async ({ request }) => {
  const res = await request.post('/api/auth/login', { data: DEMO });
  expect(res.ok()).toBe(true);
  // The demo workspace has agents off, like any new one; the specs about agent pages need them.
  // Here, once, and not in those specs: a workspace change makes every open page ask who is
  // signed in again, which a spec that has just cut the API can't answer.
  const agents = await request.patch('/api/w/demo', { data: { settings: { agents: true } } });
  expect(agents.ok(), `turn agents on: ${agents.status()}`).toBe(true);
  await request.storageState({ path: STATE });
});
