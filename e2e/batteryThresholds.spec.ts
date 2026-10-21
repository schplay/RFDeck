import { test, expect } from '@playwright/test';

// The battery levels in Settings drive the server's low and critical alerts
// and every battery color on screen. These were once saved and then ignored,
// so what is checked here is that a save is kept, kept sensible, and survives.

test.describe('battery alert levels', () => {
  let original: { batteryWarningPct: number; batteryCriticalPct: number; dropoutSensitivity: number };

  test.beforeAll(async ({ request }) => {
    original = await (await request.get('/api/settings')).json();
  });

  test.afterAll(async ({ request }) => {
    await request.put('/api/settings', {
      data: {
        batteryWarningPct: original.batteryWarningPct,
        batteryCriticalPct: original.batteryCriticalPct,
        dropoutSensitivity: original.dropoutSensitivity,
      },
    });
  });

  test('are saved as entered', async ({ request }) => {
    const saved = await (await request.put('/api/settings', {
      data: { batteryWarningPct: 35, batteryCriticalPct: 12 },
    })).json();
    expect(saved.batteryWarningPct).toBe(35);
    expect(saved.batteryCriticalPct).toBe(12);

    const read = await (await request.get('/api/settings')).json();
    expect(read.batteryWarningPct).toBe(35);
    expect(read.batteryCriticalPct).toBe(12);
  });

  test('keep critical below warning, so the low warning can still fire', async ({ request }) => {
    const saved = await (await request.put('/api/settings', {
      data: { batteryWarningPct: 10, batteryCriticalPct: 30 },
    })).json();
    expect(saved.batteryCriticalPct).toBe(30);
    expect(saved.batteryWarningPct).toBeGreaterThan(saved.batteryCriticalPct);
  });

  test('leave the levels alone when other settings are saved', async ({ request }) => {
    await request.put('/api/settings', { data: { batteryWarningPct: 33, batteryCriticalPct: 9 } });
    await request.put('/api/settings', { data: { dropoutSensitivity: original.dropoutSensitivity } });
    const read = await (await request.get('/api/settings')).json();
    expect(read.batteryWarningPct).toBe(33);
    expect(read.batteryCriticalPct).toBe(9);
  });

  test('are shown on the alerts tab after a reload', async ({ page, request }) => {
    await request.put('/api/settings', { data: { batteryWarningPct: 28, batteryCriticalPct: 7 } });
    await page.goto('/#/settings?tab=alerts');
    const card = page.locator('.settings-card', { has: page.getByRole('heading', { name: 'Battery Alerts' }) });
    await expect(card.locator('input[type="number"]').nth(0)).toHaveValue('28');
    await expect(card.locator('input[type="number"]').nth(1)).toHaveValue('7');
  });
});
