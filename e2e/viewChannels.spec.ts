import { test, expect } from '@playwright/test';
import { goLive, standDown, expectNoCrash } from './helpers';

// "View Channels" in the device drawer opens the dashboard narrowed to that
// device. The harness has no receivers, so what is checked is the path and
// the filter itself: it is visible, named, and can be cleared.

test.describe('View Channels', () => {
  let id: string;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/inventory', {
      data: { name: 'Rack Seven', manufacturer: 'Sennheiser', model: 'EW-DX EM 4', ip: '192.0.2.77', port: 443 },
    });
    expect(res.ok()).toBeTruthy();
    id = (await res.json()).id;
    await goLive(request);
  });

  test.afterAll(async ({ request }) => {
    await standDown(request);
    await request.delete(`/api/inventory/${id}`);
  });

  test('opens the dashboard showing only that device, and the filter can be cleared', async ({ page }) => {
    await page.goto('/#/inventory');
    await page.locator('.hardware-card', { hasText: 'Rack Seven' }).click();
    await page.getByRole('button', { name: 'View Channels' }).click();

    await expect.poll(() => page.url()).toContain(`#/?device=${id}`);
    await expect(page.getByRole('heading', { name: 'Monitoring' })).toBeVisible();
    await expect(page.getByText('Only Rack Seven')).toBeVisible();
    await expectNoCrash(page);

    await page.getByRole('button', { name: "Show every device's channels" }).click();
    await expect(page.getByText('Only Rack Seven')).toHaveCount(0);
    await expect(page).not.toHaveURL(/device=/);
  });
});
