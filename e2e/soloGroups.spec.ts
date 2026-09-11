import { test, expect } from '@playwright/test';

// Solo groups: eight recallable listen buses.
//
// Audio itself needs hardware the harness does not have, so what is tested is
// the working-set behaviour around it: the strip exists on the dashboard, its
// keys are advertised, and an empty group is refused rather than stored as a
// bus that silences everything on recall.

async function live(page: import('@playwright/test').Page) {
  await page.request.post('/api/live', { data: {} });
  await page.goto('/#/');
  await expect(page.getByRole('group', { name: 'Solo groups' })).toBeVisible();
}

test.describe('solo groups', () => {
  test.afterEach(async ({ request }) => { await request.delete('/api/live'); });

  test('offers eight slots, all empty on a fresh browser', async ({ page }) => {
    await live(page);
    for (let n = 1; n <= 8; n++) {
      await expect(page.getByRole('button', { name: `Solo group ${n} (empty)` })).toBeVisible();
    }
  });

  test('will not store an empty bus as a group', async ({ page }) => {
    // Nothing is playing in the harness, so shift-click must leave the slot
    // empty rather than saving a group that silences everything on recall.
    await live(page);
    await page.getByRole('button', { name: 'Solo group 1 (empty)' }).click({ modifiers: ['Shift'] });
    await expect(page.getByRole('button', { name: 'Solo group 1 (empty)' })).toBeVisible();
  });

  test('advertises its keys in the shortcut overlay', async ({ page }) => {
    await live(page);
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog.getByText('Listen to that solo group')).toBeVisible();
    await expect(dialog.getByText('Store what is playing as that solo group')).toBeVisible();
  });
});
