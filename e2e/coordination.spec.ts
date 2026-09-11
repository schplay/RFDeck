import { test, expect } from '@playwright/test';

// Frequency coordination (C.13).
//
// The harness has no hardware, so what is tested is everything around the
// solver: the panel is on the RF page, the rig endpoint says honestly that
// there is nothing to coordinate, a declared band is stored with its
// provenance and refused for a family that reports its own, and apply
// validates its input before touching anything.

test.describe('coordination', () => {
  test('the RF page offers coordination and says when there is nothing to plan', async ({ page }) => {
    await page.goto('/#/rf');
    const panel = page.getByRole('region', { name: 'Frequency coordination' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('0 transmitters ready')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Plan' })).toBeDisabled();
  });

  test('a plan on an empty rig is complete, empty and honest', async ({ request }) => {
    const res = await request.post('/api/coordination/plan', { data: {} });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.plan.assignments).toEqual([]);
    expect(body.plan.complete).toBe(true);
    expect(body.plan.moves).toBe(0);
  });

  test('declares a band for a receiver that cannot report one, with provenance', async ({ request, page }) => {
    const created = await request.post('/api/inventory', {
      data: { name: 'ULX-D rack', manufacturer: 'Shure', model: 'ULXD4D', ip: '10.255.0.10', port: 2202 },
    });
    expect(created.ok()).toBe(true);
    const device = await created.json();
    try {
      const bad = await request.put(`/api/coordination/devices/${device.id}/band`, { data: { band: 'ZZ9' } });
      expect(bad.status()).toBe(400);

      const ok = await request.put(`/api/coordination/devices/${device.id}/band`, { data: { band: 'h50' } });
      expect(ok.ok()).toBe(true);
      expect(await ok.json()).toMatchObject({ band: 'H50', bandSource: 'declared' });

      await page.goto('/#/rf');
      const panel = page.getByRole('region', { name: 'Frequency coordination' });
      await expect(panel.getByRole('combobox', { name: 'Band for ULX-D rack' })).toHaveValue('H50');
      await expect(panel.getByText('declared')).toBeVisible();

      const cleared = await request.put(`/api/coordination/devices/${device.id}/band`, { data: { band: null } });
      expect(await cleared.json()).toMatchObject({ band: null, bandSource: null });
    } finally {
      await request.delete(`/api/inventory/${device.id}`);
    }
  });

  test('refuses to tune a model RFDeck cannot drive, and validates apply', async ({ request }) => {
    const created = await request.post('/api/inventory', {
      data: { name: 'PSM', manufacturer: 'Shure', model: 'P10T', ip: '10.255.0.11', port: 2202, deviceType: 'output' },
    });
    const device = await created.json();
    try {
      const res = await request.put(`/api/coordination/devices/${device.id}/band`, { data: { band: 'G57' } });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain('cannot tune');
    } finally {
      await request.delete(`/api/inventory/${device.id}`);
    }
    expect((await request.post('/api/coordination/apply', { data: {} })).status()).toBe(400);
    expect((await request.post('/api/coordination/apply', { data: { assignments: [{ id: 'x' }] } })).status()).toBe(400);
    const missing = await request.post('/api/coordination/apply', { data: { assignments: [{ id: 'nope:1', frequencyKHz: 500000 }] } });
    expect(missing.ok()).toBe(true);
    expect(await missing.json()).toMatchObject({ sent: 0, failed: 1 });
  });
});
