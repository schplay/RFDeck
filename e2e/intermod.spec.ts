import { test, expect } from '@playwright/test';

// Intermodulation, end to end.
//
// The arithmetic is covered by unit tests. What matters here is that the panel
// is honest when there is nothing to report — because the usual and correct
// answer is nothing, and a panel that cannot say so calmly is one an operator
// learns to skip past.

test.describe('the intermodulation panel', () => {
  test('is on the RF page', async ({ page }) => {
    await page.goto('/#/rf');
    await expect(page.getByText('Intermodulation')).toBeVisible();
  });

  test('explains itself rather than showing an empty table', async ({ page }) => {
    // With no receivers connected there are no carriers, and "nothing to
    // report" and "not enough to check" are different states that would
    // otherwise look identical.
    await page.goto('/#/rf');
    await expect(
      page.getByText(/Two or more transmitters have to be reporting|No third-order product lands/),
    ).toBeVisible();
  });

  test('sits above the frequency table, being a finding rather than a reference', async ({ page }) => {
    await page.goto('/#/rf');
    // Against the table card itself, not the words "Active Frequencies" — the
    // page header carries that phrase too, as a count, and matching it made
    // this assert something about the header instead.
    const imBox = await page.getByText('Intermodulation').first().boundingBox();
    const tableBox = await page.locator('.table-card').boundingBox();
    expect(imBox!.y).toBeLessThan(tableBox!.y);
  });
});
