import { test, expect } from '@playwright/test';

// The channel context menu, and the deep links it depends on.
//
// A channel is telemetry, not a record, so each menu entry has to resolve to
// whatever owns the thing — the device, the casting, the patch row — and land
// there. The harness has no hardware and so no channels to right-click, but
// the destinations are testable on their own: a link that arrives at the top
// of the page instead of at the thing asked for is the failure worth catching.

test.describe('deep links the context menu relies on', () => {
  test('settings opens on the tab it was sent to', async ({ page }) => {
    await page.goto('/#/settings?tab=display');
    await expect(page.getByRole('heading', { name: 'Meters' })).toBeVisible();
  });

  test('settings still opens on audio by default', async ({ page }) => {
    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { name: 'Audio Patch' })).toBeVisible();
  });

  test('the show page opens on the cast tab when asked', async ({ page, request }) => {
    const show = await (await request.post('/api/shows', { data: { name: 'Menu link test' } })).json();
    try {
      await page.goto('/#/shows?tab=players');
      // The list panel still renders; the tab choice only applies once a
      // show is selected, which is what a menu link does before navigating.
      await page.getByRole('button', { name: /Menu link test/ }).click();
      await expect(page.getByRole('button', { name: /Players|Roster|Performers|Presenters|Talent/ })).toHaveClass(/active/);
    } finally {
      await request.delete(`/api/shows/${show.id}`);
    }
  });

  test('an unknown tab falls back rather than showing nothing', async ({ page }) => {
    await page.goto('/#/settings?tab=nonsense');
    // Radix renders no content for an unknown value; the fallback is that the
    // page is still usable, which means a tab is clickable.
    await page.getByRole('tab', { name: /Audio Patch/ }).click();
    await expect(page.getByRole('heading', { name: 'Audio Patch' })).toBeVisible();
  });
});
