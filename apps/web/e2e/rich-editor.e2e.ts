import { expect, test, unique } from './fixtures.ts';

test('format a description in the rich editor, and it is stored as Markdown', async ({
  page,
  api,
}) => {
  const issue = await api.createIssue('ENG', unique('Rich text'));
  await page.goto(`/demo/issue/${issue.identifier}`);
  await page.getByRole('button', { name: 'Add a description…' }).click();
  const editor = page.locator('main [contenteditable="true"]').first();
  await expect(editor).toBeFocused();

  // Markdown shortcuts and the bold hotkey, as someone typing would use them.
  await page.keyboard.type('## Plan');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('Bold');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type(' then plain');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await expect(editor.locator('h2')).toHaveText('Plan');
  await expect(editor.locator('strong')).toHaveText('Bold');
  await expect(editor.locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  const markdown = '## Plan\n\n**Bold** then plain\n\n- first\n- second';
  await expect.poll(async () => (await api.issue(issue.id)).description.trim()).toBe(markdown);
  await page.reload();
  const shown = page.getByRole('main');
  await expect(shown.getByRole('heading', { name: 'Plan', level: 2 })).toBeVisible();
  await expect(shown.locator('strong', { hasText: 'Bold' })).toBeVisible();
  await expect(shown.getByRole('listitem')).toHaveText(['first', 'second']);
});
