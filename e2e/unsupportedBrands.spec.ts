import { test, expect } from '@playwright/test';

// A device from a brand RFDeck cannot talk to. It is never contacted, so it
// must read as not supported rather than as an offline fault, and must not
// count against how much of the rig is reporting.

test.describe('a device from an unsupported brand', () => {
  let id: string;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/inventory', {
      data: { name: 'Wisy RX', manufacturer: 'Wisycom', model: 'MRK960', ip: '192.0.2.44', port: 2101 },
    });
    expect(res.ok()).toBeTruthy();
    id = (await res.json()).id;
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/inventory/${id}`);
  });

  test('is shown as not supported in the inventory', async ({ page }) => {
    await page.goto('/#/inventory');
    const card = page.locator('.hardware-card', { hasText: 'Wisy RX' });
    await expect(card.getByText('Not supported')).toBeVisible();
  });

  test('says why in the device drawer, instead of calling it offline', async ({ page }) => {
    await page.goto('/#/inventory');
    await page.locator('.hardware-card', { hasText: 'Wisy RX' }).click();
    await expect(page.getByText('RFDeck cannot monitor Wisycom devices, so it does not contact this one.')).toBeVisible();
    await expect(page.getByText('Device Offline / Unreachable')).toHaveCount(0);
  });
});
