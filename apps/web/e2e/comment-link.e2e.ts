import { DEMO, expect, test, unique } from './fixtures.ts';

test('a comment link opens the issue scrolled to that comment', async ({ page, api, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const issue = await api.createIssue('ENG', unique('Comment link'));
  // Enough comments that the last one starts out below the fold.
  let lastId = '';
  for (let i = 0; i < 12; i++) {
    const res = await api.request.post(`/api/w/demo/issues/${issue.id}/comments`, {
      data: { body: `Comment number ${i}\n\nwith\n\nsome\n\nheight` },
    });
    expect(res.ok()).toBe(true);
    lastId = (await res.json()).id;
  }

  // The copy action gives the deep link.
  await page.goto(`/demo/issue/${issue.identifier}`);
  const target = page.locator(`#comment-${lastId}`);
  await target.getByRole('button', { name: 'Copy link to comment' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const { pathname, hash } = new URL(link);
  expect(pathname + hash).toBe(`/demo/issue/${issue.identifier}#comment-${lastId}`);

  // Opened fresh, the comments load after the page does: it still scrolls there and outlines it.
  await page.goto('/demo/my-issues/assigned');
  await page.goto(link);
  await expect(target).toHaveAttribute('data-focused', 'true');
  await expect(target).toBeInViewport();
  await expect(page).toHaveURL(link);
  await expect(page.locator('.comment[data-focused]')).toHaveCount(1);
});

test.describe('signed out', () => {
  // Asking who is signed in answers 401 until the form is done.
  test.use({
    storageState: { cookies: [], origins: [] },
    allowConsoleErrors: /status of 401 .*\/api\/auth\/me\)/,
  });

  test('a comment link survives signing in', async ({ page, api }) => {
    const issue = await api.createIssue('ENG', unique('Comment link sign-in'));
    const res = await api.request.post(`/api/w/demo/issues/${issue.id}/comments`, {
      data: { body: 'Linked comment' },
    });
    const { id } = await res.json();

    await page.goto(`/demo/issue/${issue.identifier}#comment-${id}`);
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await page.getByRole('textbox', { name: 'Email' }).fill(DEMO.email);
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('textbox', { name: 'Password' }).fill(DEMO.password);
    await page.getByRole('button', { name: /Sign in with password/ }).click();
    await expect(page).toHaveURL(new RegExp(`/demo/issue/${issue.identifier}#comment-${id}$`));
    await expect(page.locator(`#comment-${id}`)).toHaveAttribute('data-focused', 'true');
  });
});
