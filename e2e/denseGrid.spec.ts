import { test, expect } from '@playwright/test';

// The dense grid: every channel on one screen.
//
// The card dashboard is right for detail and wrong past thirty channels. The
// dense view drops everything that needs a second look and keeps only whether
// anything is wrong. What is tested here is the part that makes it usable as a
// wall display: the choice survives a reload, and it does not vanish the
// moment the operator leaves the page.

// The dashboard shows a Go Live panel instead of channels until the rig is
// live, so these tests go live first — the harness runs with no hardware, so
// nothing is actually tracked, but the view toggle appears.
async function live(page: import('@playwright/test').Page) {
  await page.request.post('/api/live', { data: {} });
  await page.goto('/#/');
  await expect(page.getByTitle('Dense View')).toBeVisible();
}

test.describe('the dense grid', () => {
  test.afterEach(async ({ request }) => {
    await request.delete('/api/live');
  });

  test('is a third view beside cards and list', async ({ page }) => {
    await live(page);
    await page.getByTitle('Dense View').click();
    await expect(page.locator('.dashboard-content.dense')).toBeVisible();
  });

  test('survives a reload, or it is not a wall display', async ({ page }) => {
    await live(page);
    await page.getByTitle('Dense View').click();
    await page.reload();
    await expect(page.locator('.dashboard-content.dense')).toBeVisible();
  });

  test('survives leaving the page and coming back', async ({ page }) => {
    await live(page);
    await page.getByTitle('Dense View').click();
    await page.getByRole('link', { name: 'Inventory' }).click();
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.locator('.dashboard-content.dense')).toBeVisible();
  });

  test('cards remain the default for a fresh browser', async ({ page }) => {
    await live(page);
    await expect(page.locator('.dashboard-content.grid')).toBeVisible();
  });
});
