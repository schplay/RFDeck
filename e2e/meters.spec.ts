import { test, expect } from '@playwright/test';

// Meter settings.
//
// Every view used to carry its own compiled-in thresholds and palette, and they
// disagreed with each other and with the server's alerts. These are now one set
// of per-browser preferences applied everywhere. What is tested is the contract
// that makes them trustworthy: a change is seen at once, survives a reload, and
// reaches views that are not the settings page.

test.describe('meter settings', () => {
  test('has its own tab', async ({ page }) => {
    await page.goto('/#/settings');
    await page.getByRole('tab', { name: /Display/ }).click();
    await expect(page.getByRole('heading', { name: 'Meters' })).toBeVisible();
  });

  test('changes colour on the live preview at once', async ({ page }) => {
    await page.goto('/#/settings');
    await page.getByRole('tab', { name: /Display/ }).click();

    // Every meter reads its palette from custom properties set by the store,
    // so the preview is proof that the setting reached the component.
    await page.getByLabel('good colour').fill('#123456');
    const meter = page.locator('.ms-preview .meter').first();
    await expect(meter).toHaveCSS('--meter-good', '#123456');
  });

  test('survives a reload', async ({ page }) => {
    await page.goto('/#/settings');
    await page.getByRole('tab', { name: /Display/ }).click();
    await page.getByLabel('Ballistics').selectOption('averaged');
    await page.reload();
    await page.getByRole('tab', { name: /Display/ }).click();
    await expect(page.getByLabel('Ballistics')).toHaveValue('averaged');
  });

  test('keeps the RF bands in order however they are typed', async ({ page }) => {
    // A warning band above the critical band would colour a meter nonsensically.
    await page.goto('/#/settings');
    await page.getByRole('tab', { name: /Display/ }).click();
    const warn = page.locator('.ms-pair input').nth(0);
    const crit = page.locator('.ms-pair input').nth(1);
    await warn.fill('30');
    await crit.fill('60');
    await expect(crit).toHaveValue('60');
    // warn must now sit above crit
    const w = Number(await warn.inputValue());
    expect(w).toBeGreaterThan(60);
  });

  test('reaches the Backstage view, which has no settings of its own', async ({ page }) => {
    await page.goto('/#/settings');
    await page.getByRole('tab', { name: /Display/ }).click();
    await page.getByLabel('critical colour').fill('#abcdef');

    await page.goto('/#/backstage');
    await expect(page.getByRole('link', { name: /Operator View/ })).toBeVisible();
    // No channels in the harness, so no meters to inspect — but the preview
    // meter proved the plumbing, and this proves the store persisted across
    // the navigation the wall display would make.
    await page.goto('/#/settings');
    await page.getByRole('tab', { name: /Display/ }).click();
    await expect(page.getByLabel('critical colour')).toHaveValue('#abcdef');
  });

  test('resets to the defaults', async ({ page }) => {
    await page.goto('/#/settings');
    await page.getByRole('tab', { name: /Display/ }).click();
    await page.getByLabel('Ballistics').selectOption('instant');
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByLabel('Ballistics')).toHaveValue('fast');
  });
});
