import { test, expect } from '@playwright/test';

// Listen groups: eight recallable listen buses.
//
// Audio itself needs hardware the harness does not have, so what is tested is the
// working-set behaviour around it: the strip exists on the dashboard, its keys are
// advertised, and an empty group cannot be stored as a bus that would silence
// everything on recall.
//
// The wording here is "listen", not "solo". The plan calls the feature solo groups
// (C.4) and the UI calls it Listen, matching the per-channel Listen action — one word
// for one thing, from the operator's side. These tests follow the UI, since that is
// what they are driving.

async function live(page: import('@playwright/test').Page) {
  await page.request.post('/api/live', { data: {} });
  await page.goto('/#/');
  await expect(page.getByRole('group', { name: 'Listen groups' })).toBeVisible();
}

test.describe('listen groups', () => {
  test.afterEach(async ({ request }) => { await request.delete('/api/live'); });

  test('offers eight slots, all empty on a fresh browser', async ({ page }) => {
    await live(page);
    for (let n = 1; n <= 8; n++) {
      // An empty slot is a save button, so that is what it calls itself.
      await expect(page.getByRole('button', { name: `Save current listen bus as group ${n}` }))
        .toBeVisible();
    }
  });

  test('will not store an empty bus as a group', async ({ page }) => {
    // Nothing is playing in the harness, so there is nothing to save — and the slot
    // is disabled rather than merely refusing the click. That is a stronger
    // guarantee than the previous behaviour, which let an operator click and then
    // quietly did nothing: a group that silences everything on recall is worse than
    // a button that says it is not available yet.
    await live(page);
    const slot = page.getByRole('button', { name: 'Save current listen bus as group 1' });
    await expect(slot).toBeDisabled();
    // Still empty afterwards: no recall button appeared for group 1.
    await expect(page.getByRole('button', { name: /^Listen to group 1/ })).toHaveCount(0);
  });

  test('says what an empty slot is waiting for', async ({ page }) => {
    // The slot is disabled, so the tooltip is the only thing that can explain why.
    await live(page);
    await expect(page.getByRole('button', { name: 'Save current listen bus as group 1' }))
      .toHaveAttribute('title', /Listen to some channels, then click here/i);
  });

  test('advertises its keys in the shortcut overlay', async ({ page }) => {
    await live(page);
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog.getByText('Listen to that group')).toBeVisible();
    await expect(dialog.getByText('Save what is playing as that group')).toBeVisible();
  });

  test('can show what each group holds', async ({ page }) => {
    // The panel added with the rewrite: a tooltip answers one slot at a time, which
    // is no use when the question is "which one was the band?".
    await live(page);
    // Named by its text, "Groups" — the `title` is a tooltip, not the accessible
    // name, and asking for the tooltip text here found nothing.
    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Listen groups' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/No groups saved yet/i)).toBeVisible();
  });
});
