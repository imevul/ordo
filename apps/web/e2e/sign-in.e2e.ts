import { DEMO, expect, test, unique } from './fixtures.ts';

// Signed out: this spec goes through the sign-in form. Asking who is signed in answers 401 until then.
test.use({
  storageState: { cookies: [], origins: [] },
  allowConsoleErrors: /status of 401 .*\/api\/auth\/me\)/,
});

test('sign in with email then password, create an issue with the keyboard', async ({
  page,
  api,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('textbox', { name: 'Email' }).fill(DEMO.email);
  await page.getByRole('button', { name: /Continue/ }).click();
  // The second step asks for the password of the address given on the first.
  await expect(page.getByText(DEMO.email)).toBeVisible();
  await page.getByRole('textbox', { name: 'Password' }).fill(DEMO.password);
  await page.getByRole('button', { name: /Sign in with password/ }).click();
  await expect(page).toHaveURL(/\/demo\//);

  await page.goto('/demo/team/ENG/all');
  await expect(page.getByRole('heading', { name: 'Engineering' })).toBeVisible();
  const title = unique('Keyboard-made issue');
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New issue' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'DES' }).click();
  await page.getByRole('option', { name: /Engineering/ }).click();
  await dialog.getByRole('textbox', { name: 'Issue title' }).fill(title);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(dialog).toBeHidden();

  const row = page.getByRole('link', { name: title });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/demo\/issue\/ENG-\d+$/);
  await expect(page.getByRole('textbox', { name: 'Issue title' })).toHaveValue(title);

  const identifier = page.url().split('/').pop()!;
  expect((await api.issue(identifier)).title).toBe(title);
});
