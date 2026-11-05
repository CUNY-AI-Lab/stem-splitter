import { expect } from '@playwright/test';

export async function openSplitActions(scope) {
  const toggle = scope.locator('.actions-toggle').first();
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

export async function clickLiveAction(page, name) {
  if (await page.locator('.console-actions .class-live').count()) await openSplitActions(page);
  await page.getByRole('button', { name, exact: true }).click();
}
