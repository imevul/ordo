import type { Page } from '@playwright/test';
import { expect, test, unique } from './fixtures.ts';

/** A board column, found by its "New issue in …" button: header, then the column around it. */
const column = (page: Page, name: string) =>
  page.getByRole('button', { name: `New issue in ${name}`, exact: true }).locator('xpath=../..');

test('drag a card to another status, and it stays there after a reload', async ({ page, api }) => {
  const issue = await api.createIssue('ENG', unique('Drag me'), 'Backlog');
  const todo = await api.state('ENG', 'Todo');
  await page.goto('/demo/team/ENG/all');
  await page.getByRole('button', { name: 'Board layout' }).click();

  const card = column(page, 'Backlog').locator(`[data-issue-id="${issue.id}"]`);
  await expect(card).toBeVisible();
  const from = (await card.boundingBox())!;
  const to = (await column(page, 'Todo').boundingBox())!;
  // At 375px only the Todo column's left edge is on screen; dropping there is enough.
  const width = page.viewportSize()!.width;
  const target = { x: Math.min(to.x + 40, width - 10), y: to.y + 80 };
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 15 });
  await page.mouse.move(target.x, target.y + 2);
  await page.mouse.up();

  await expect(column(page, 'Todo').locator(`[data-issue-id="${issue.id}"]`)).toBeVisible();
  await expect.poll(async () => (await api.issue(issue.id)).stateId).toBe(todo.id);
  await page.reload();
  await expect(column(page, 'Todo').locator(`[data-issue-id="${issue.id}"]`)).toBeVisible();
  await expect(column(page, 'Backlog').locator(`[data-issue-id="${issue.id}"]`)).toHaveCount(0);
});
