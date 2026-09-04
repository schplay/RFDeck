import { test, expect } from '@playwright/test';
import { open, expectNoCrash, goLive, standDown } from './helpers';

// The phone. RFDeck shipped as a desktop layout you scrolled around on a
// phone, and the fix was invisible from a desktop test run — so this project
// runs at a phone viewport and asserts the two things that were actually
// wrong: the sidebar took the screen, and pages scrolled sideways.

/** Fail if the document is wider than the screen it is being read on. */
async function expectNoHorizontalScroll(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  // A pixel or two is rounding; a genuine overflow is tens or hundreds.
  expect(overflow, 'the page scrolls sideways on a phone').toBeLessThanOrEqual(2);
}

test.describe('on a phone', () => {
  test.beforeEach(async ({ request }) => { await goLive(request, null); });
  test.afterEach(async ({ request }) => { await standDown(request); });

  test('the sidebar is a drawer behind a hamburger', async ({ page }) => {
    await open(page, '/');

    // Off-canvas until asked for, so the content gets the screen.
    await expect(page.locator('.mobile-topbar')).toBeVisible();
    await expect(page.locator('.sidebar')).not.toHaveClass(/open/);

    await page.getByRole('button', { name: /Open navigation/i }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/open/);

    // A link closes it — otherwise the drawer covers the page just navigated to.
    await page.getByRole('link', { name: 'Inventory' }).click();
    await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
    await expect(page.getByText(/Hardware Inventory/)).toBeVisible();
  });

  test('the backdrop closes the drawer', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('button', { name: /Open navigation/i }).click();
    await expect(page.locator('.nav-backdrop')).toBeVisible();

    await page.locator('.nav-backdrop').click();
    await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  });

  for (const route of ['/', '/inventory', '/rf', '/battery', '/settings', '/performers', '/detections', '/micboard']) {
    test(`${route} does not scroll sideways`, async ({ page }) => {
      await open(page, route);
      await expectNoCrash(page);
      await expectNoHorizontalScroll(page);
    });
  }
});
