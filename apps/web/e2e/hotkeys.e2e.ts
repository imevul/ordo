import { expect, test } from './fixtures.ts';

test('g-sequences navigate; page shortcuts stay quiet under a modal or the palette', async ({
  page,
}) => {
  await page.goto('/demo/my-issues/assigned');
  await expect(page.getByRole('heading', { name: 'My issues' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await expect(page).toHaveURL(/\/demo\/inbox$/);
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/demo\/projects$/);

  // A modal takes the keyboard: neither sequences nor single keys reach the page underneath.
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'New issue' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/demo\/projects$/);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // In the command palette, keys are typing.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command menu' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('gi c');
  await expect(palette.getByRole('combobox')).toHaveValue('gi c');
  await expect(page.getByRole('dialog', { name: 'New issue' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/demo\/projects$/);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Back on the page, shortcuts work again.
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await expect(page).toHaveURL(/\/demo\/inbox$/);
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'New issue' })).toBeVisible();
});
