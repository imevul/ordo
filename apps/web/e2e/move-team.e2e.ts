import { expect, test, unique } from './fixtures.ts';

test('move an issue to another team: the URL follows, the old identifier still works', async ({
  page,
  api,
}) => {
  const title = unique('Moving house');
  const issue = await api.createIssue('ENG', title);
  await page.goto(`/demo/issue/${issue.identifier}`);
  await expect(page.getByRole('textbox', { name: 'Issue title' })).toHaveValue(title);

  await page.getByRole('main').getByRole('button', { name: 'Engineering', exact: true }).click();
  await page.getByRole('option', { name: /Design/ }).click();

  await expect(page).toHaveURL(/\/demo\/issue\/DES-\d+$/);
  const moved = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { name: moved, level: 1 })).toBeVisible();
  expect((await api.issue(moved)).id).toBe(issue.id);

  // Old links keep working: the API resolves the old identifier, the page lands on the new one.
  expect((await api.issue(issue.identifier)).id).toBe(issue.id);
  await page.goto(`/demo/issue/${issue.identifier}`);
  await expect(page).toHaveURL(new RegExp(`/demo/issue/${moved}$`));
  await expect(page.getByRole('textbox', { name: 'Issue title' })).toHaveValue(title);
});
