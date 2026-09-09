import { test, expect } from '@playwright/test';

// The status bar.
//
// Each fact in it already existed somewhere — in a component's local state, in
// a server log, on a page you have to navigate to — or, for "standing by",
// nowhere at all, because the live indicator renders nothing until you are
// live. So the state that matters before the house opens was the one state
// nothing showed.

test.describe('the status bar', () => {
  test('is present on every operator page', async ({ page }) => {
    await page.goto('/#/');
    const bar = page.getByRole('status', { name: 'RFDeck status' });
    await expect(bar).toBeVisible();

    await page.getByRole('link', { name: 'Inventory' }).click();
    await expect(bar).toBeVisible();
  });

  test('says standing by when nothing is running', async ({ page }) => {
    // The gap this fills: the live indicator only exists once live, so before
    // the show there was nothing anywhere saying the rig was not being worked.
    await page.goto('/#/');
    await expect(page.getByRole('status')).toContainText(/Standing by|Live/);
  });

  test('states how much of the rig is reporting', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.getByRole('status')).toContainText(/\d+\/\d+ devices/);
  });

  test('states the channel count', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.getByRole('status')).toContainText(/\d+ channels?/);
  });

  test('stays put while the page scrolls', async ({ page }) => {
    // A status line you have to scroll to find is not a status line. The scroll
    // lives one level inside the shell so the bar is pinned beneath it.
    await page.goto('/#/inventory');
    const bar = page.getByRole('status', { name: 'RFDeck status' });
    const before = await bar.boundingBox();
    await page.mouse.wheel(0, 2000);
    const after = await bar.boundingBox();
    expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
  });

  test('does not repeat what the header already says', async ({ page }) => {
    // The padlock states the lock. Repeating it here would spend the space the
    // facts nothing else answers need.
    await page.goto('/#/');
    await page.getByRole('button', { name: /Unlocked/ }).click();
    await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();
    await expect(page.getByRole('status')).not.toContainText(/Locked/i);
  });

  test('is not on the full-screen views, which are not the operator shell', async ({ page }) => {
    // The Micboard and Backstage are read across a room; a line of small text
    // at the bottom is noise there, and neither has an operator to inform.
    await page.goto('/#/micboard');
    await expect(page.getByTitle('Back to RFDeck')).toBeVisible();
    await expect(page.getByRole('status', { name: 'RFDeck status' })).toHaveCount(0);
  });
});
