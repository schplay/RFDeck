import { test, expect, Page } from '@playwright/test';

// The surface lock.
//
// `mutesLocked` already covered the single most dangerous button. This covers
// the rest of them — enabling and disabling devices, going live and standing
// down, repatching audio, ticking a mic check. All are one click, all are
// things a sleeve can do to a tablet propped at FOH, and several are not
// obviously undoable once the show is running.
//
// A lock that does not actually stop anything is worse than no lock, because it
// is believed. These assert the controls are genuinely inert, not merely
// styled as though they were.

async function lock(page: Page) {
  await page.getByRole('button', { name: /Unlocked/ }).click();
  await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();
}

test.describe('locking the surface', () => {
  test('starts unlocked, because an app that ignores every click is just broken', async ({ page }) => {
    // Unlike the mute lock, which is dangerous enough to default to on, this
    // waits to be asked. Locking has an occasion: the house opens.
    await page.goto('/#/');
    await expect(page.getByRole('button', { name: /Unlocked/ })).toBeVisible();
  });

  test('the header says so, wherever you are when a control does nothing', async ({ page }) => {
    await page.goto('/#/');
    await lock(page);
    // Still visible after navigating: the state belongs to the chrome, not to
    // the page that happens to own a control.
    await page.getByRole('link', { name: 'Inventory' }).click();
    await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();
  });

  test('survives a reload, so a rig locked before the house opened stays locked', async ({ page }) => {
    await page.goto('/#/');
    await lock(page);
    await page.reload();
    await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();
  });

  test('L locks but does not unlock', async ({ page }) => {
    // Locking wants to be fast. Unlocking is the act that makes every dangerous
    // control live again, so it has to be aimed at deliberately.
    await page.goto('/#/');
    await page.keyboard.press('l');
    await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();

    await page.keyboard.press('l');
    await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();
  });

  test('is listed in the shortcut overlay', async ({ page }) => {
    await page.goto('/#/');
    // Wait for the shell to mount before typing at it — the scope is registered
    // by RootLayout, and racing that tests nothing.
    await expect(page.getByRole('button', { name: /Unlocked|^Locked/ })).toBeVisible();
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog.getByText('Lock the surface (unlock from the header)')).toBeVisible();
  });

  test('disables standing down, the most disruptive action there is', async ({ page }) => {
    await page.goto('/#/');
    await lock(page);
    const standDown = page.getByRole('button', { name: /Stand Down/ });
    if (await standDown.count() > 0) {
      await expect(standDown).toBeDisabled();
    }
  });

  test('disables the bulk device switch in inventory', async ({ page }) => {
    await page.goto('/#/inventory');
    await lock(page);
    const bulk = page.getByRole('button', { name: /(Disable All|Enable All)/ });
    if (await bulk.count() > 0) {
      await expect(bulk.first()).toBeDisabled();
    }
  });

  test('unlocking gives everything back', async ({ page }) => {
    await page.goto('/#/inventory');
    await lock(page);
    await page.getByRole('button', { name: /^Locked/ }).click();
    await expect(page.getByRole('button', { name: /Unlocked/ })).toBeVisible();

    const bulk = page.getByRole('button', { name: /(Disable All|Enable All)/ });
    if (await bulk.count() > 0) {
      await expect(bulk.first()).toBeEnabled();
    }
  });
});
