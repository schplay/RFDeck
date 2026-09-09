import { test, expect, Page } from '@playwright/test';

// Keyboard shortcuts have to be findable.
//
// RFDeck had three sets of them and no way to discover any: they were written
// for an operator who already knew they were there. The overlay is the fix, and
// it lists what is registered right now rather than a hand-maintained table —
// so a key that changes cannot leave the documentation behind.

// Every test that presses a key waits for the view to mount first. A shortcut
// cannot fire before React has bound it, and a test that races that passes or
// fails on machine speed rather than on the code — which is exactly what
// happened the first time these were written.
async function ready(page: Page) {
  await expect(page.getByRole('button', { name: /Unlocked|^Locked/ })).toBeVisible();
}

test.describe('the shortcut overlay', () => {
  test('opens on ? and closes on Escape', async ({ page }) => {
    await page.goto('/#/');
    await ready(page);
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('opens from the header button, for anyone who does not know about ?', async ({ page }) => {
    await page.goto('/#/');
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  test('lists the keys the current view actually binds', async ({ page }) => {
    // Backstage binds 1-4. The overlay reads the live registry, so this asserts
    // the binding and its description are the same object.
    await page.goto('/#/backstage');
    // Wait for the view to mount before typing at it: a shortcut cannot fire
    // before React has bound it, and a test that races that is testing nothing.
    await expect(page.getByRole('link', { name: /Operator View/ })).toBeVisible();
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Backstage')).toBeVisible();
    await expect(dialog.getByText('1-4')).toBeVisible();
  });

  test('works on the full-screen views, which have no sidebar to ask', async ({ page }) => {
    // The Micboard is the screen somebody is most likely to be put in front of
    // with no explanation.
    await page.goto('/#/micboard');
    await expect(page.getByTitle('Back to RFDeck')).toBeVisible();
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Micboard')).toBeVisible();
    await expect(dialog.getByText('Full screen')).toBeVisible();
  });

  test('advertises only what the view in front of you binds', async ({ page }) => {
    // Registration is scoped to what is mounted, so leaving a view withdraws
    // its keys rather than promising them everywhere.
    await page.goto('/#/backstage');
    await expect(page.getByRole('link', { name: /Operator View/ })).toBeVisible();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog').getByText('Backstage')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.goto('/#/micboard');
    await expect(page.getByTitle('Back to RFDeck')).toBeVisible();
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog.getByText('Micboard')).toBeVisible();
    await expect(dialog.getByText('Backstage')).toHaveCount(0);
  });

  test('does not fire a shortcut while someone is typing', async ({ page }) => {
    // Backstage bound 1-4 with no check on the event target at all, so typing a
    // digit into any field on the page silently changed the column layout.
    await page.goto('/#/inventory');
    const search = page.getByPlaceholder(/search/i).first();
    await search.click();
    await search.fill('2');
    // The overlay must not have opened, and the digit must have reached the box.
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
    await expect(search).toHaveValue('2');
  });
});
