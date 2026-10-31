import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, unique } from './fixtures.ts';

// Requests made without a connection fail in the console; that's what this spec is about.
test.use({
  allowConsoleErrors: /net::ERR_INTERNET_DISCONNECTED|WebSocket connection to .* failed/,
});

const banner = (page: Page) => page.getByRole('status').filter({ hasText: 'Offline' });

/**
 * The API out of reach while the dev server still serves the app. A real offline reload needs
 * the service worker's copy of the built app, which `vite dev` doesn't make; to the app, an
 * unreachable API is the same as no network.
 */
async function cutApi(context: BrowserContext) {
  // The server's /api, not the app's own modules under /src/api.
  await context.route(/^https?:\/\/[^/]+\/api\//, (route) => route.abort('internetdisconnected'));
  await context.routeWebSocket(/^wss?:\/\/[^/]+\/api\/ws/, (ws) => ws.close());
}

test('changes made offline survive a reload and reach the server once back', async ({
  page,
  context,
  api,
}) => {
  const existing = await api.createIssue('ENG', unique('Edit me offline'));
  // Load the issue page and the create form once while online. A build's service worker keeps every
  // chunk; `vite dev` serves modules on demand, so one first imported offline would fail to load.
  await page.goto(`/demo/issue/${existing.identifier}`);
  await expect(page.getByRole('button', { name: 'Add a description…' })).toBeVisible();
  await page.goto('/demo/team/ENG/all');
  await expect(page.getByRole('link', { name: existing.title })).toBeVisible();
  await page.keyboard.press('c');
  await expect(
    page.getByRole('dialog', { name: 'New issue' }).locator('[contenteditable]'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await context.setOffline(true);
  await expect(banner(page)).toContainText('showing this device’s copy');

  // Create one…
  const title = unique('Made offline');
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New issue' });
  await dialog.getByRole('button', { name: 'DES' }).click();
  await page.getByRole('option', { name: /Engineering/ }).click();
  await dialog.getByRole('textbox', { name: 'Issue title' }).fill(title);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(dialog).toBeHidden();
  const created = page.locator('[data-issue-id]', { has: page.getByRole('link', { name: title }) });
  await expect(created).toBeVisible();
  // Made here, so its id is known before the server has seen it.
  const createdId = (await created.getAttribute('data-issue-id'))!;

  // …and edit another.
  await page.getByRole('link', { name: existing.title }).click();
  const edited = `${existing.title} (edited)`;
  const titleBox = page.getByRole('textbox', { name: 'Issue title' });
  await titleBox.fill(edited);
  await titleBox.press('Enter');
  await expect(banner(page)).toContainText('2 waiting');

  // Reload with the server still out of reach: the page comes from this device's copy.
  await cutApi(context);
  await context.setOffline(false);
  await page.reload();
  await expect(banner(page)).toContainText('showing this device’s copy');
  await expect(page.getByRole('textbox', { name: 'Issue title' })).toHaveValue(edited);
  await expect(banner(page)).toContainText('2 waiting');
  await page.getByRole('main').getByRole('link', { name: 'Engineering' }).click();
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  expect((await api.issue(existing.id)).title).toBe(existing.title);

  // Back online: the outbox goes out.
  await context.unrouteAll();
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(banner(page)).toBeHidden({ timeout: 20_000 });
  await expect.poll(async () => (await api.issue(existing.id)).title).toBe(edited);
  await expect.poll(async () => (await api.issue(createdId)).title).toBe(title);
});

test('closing the tab that syncs hands the job to another tab', async ({ context, api }) => {
  const issue = await api.createIssue('ENG', unique('Two tabs'));
  const first = await context.newPage();
  await first.goto(`/demo/issue/${issue.identifier}`);
  await expect(first.getByRole('textbox', { name: 'Issue title' })).toHaveValue(issue.title);
  const second = await context.newPage();
  await second.goto(`/demo/issue/${issue.identifier}`);
  await expect(second.getByRole('textbox', { name: 'Issue title' })).toHaveValue(issue.title);

  // The first tab holds the lock and talks to the server; the second only sends through it.
  await first.close();
  const edited = `${issue.title} (from the second tab)`;
  const titleBox = second.getByRole('textbox', { name: 'Issue title' });
  await titleBox.fill(edited);
  await titleBox.press('Enter');
  await expect.poll(async () => (await api.issue(issue.id)).title).toBe(edited);
});
