import { test, expect } from '@playwright/test';
import { expectNoCrash } from './helpers';

// The frequency history on the RF page. The harness has no receivers, so no
// carrier moves here; the recording itself is covered by the server's unit
// tests. What is checked is that the panel is on the page, reads its history
// from the server, and says plainly when there is none.

test.describe('frequency history', () => {
  test('is on the RF page and says when nothing has moved', async ({ page }) => {
    await page.goto('/#/rf');
    await expect(page.getByText('Frequency History', { exact: true })).toBeVisible();
    await expect(page.getByText('No frequency changes recorded')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export frequency history as CSV' })).toBeDisabled();
    await expectNoCrash(page);
  });

  test('offers the filter for who moved a carrier', async ({ page }) => {
    await page.goto('/#/rf');
    const group = page.getByRole('group', { name: 'Changed by' });
    for (const name of ['All', 'At the receiver', 'RFDeck']) {
      await expect(group.getByRole('button', { name })).toBeVisible();
    }
  });

  test('is served by the server, both kinds in one request', async ({ request }) => {
    const res = await request.get('/api/events?type=FREQUENCY_SET,FREQUENCY_CHANGE&limit=10');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    for (const e of body.events) expect(['FREQUENCY_SET', 'FREQUENCY_CHANGE']).toContain(e.type);
  });
});
