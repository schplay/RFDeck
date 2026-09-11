import { test, expect } from '@playwright/test';

// Spectrum scans (C.3 stage 1): import the files the coordination tools
// write, keep one shape, draw it under the frequency map, export the form
// they all read, and turn a scan into exclusions for coordination.

const WSM = 'Frequency;RF level (%);RF level\n' + Array.from({ length: 41 }, (_, i) => {
  const kHz = 470_000 + i * 25;
  // One strong carrier at 470.500, otherwise a quiet floor.
  const dBm = kHz === 470_500 ? -55 : -105;
  return `${kHz};;${dBm}`;
}).join('\n') + '\n';

test.describe('scans', () => {
  test('imports a WSM export, lists it, exports the WWB form, and derives exclusions', async ({ request }) => {
    const created = await request.post('/api/scans', { data: { name: 'Stage left', text: WSM } });
    expect(created.status()).toBe(201);
    const scan = await created.json();
    expect(scan).toMatchObject({ name: 'Stage left', source: 'wsm', startKHz: 470_000, stepKHz: 25, points: 41, endKHz: 471_000 });
    try {
      const list = await (await request.get('/api/scans')).json();
      expect(list.some((s: any) => s.id === scan.id)).toBe(true);

      const full = await (await request.get(`/api/scans/${scan.id}`)).json();
      expect(full.levelsDbm).toHaveLength(41);
      expect(full.levelsDbm[20]).toBe(-55);

      const csv = await request.get(`/api/scans/${scan.id}/export.csv`);
      expect(csv.headers()['content-type']).toContain('text/csv');
      const lines = (await csv.text()).trim().split('\n');
      expect(lines[0]).toBe('470.000,-105.0');
      expect(lines[20]).toBe('470.500,-55.0');

      const ex = await (await request.post(`/api/scans/${scan.id}/exclusions`, { data: { thresholdDbm: -70, marginKHz: 100 } })).json();
      expect(ex.exclusionsKHz).toEqual([[470_400, 470_600]]);

      // The coordinator takes the same scan directly.
      const plan = await (await request.post('/api/coordination/plan', { data: { scanId: scan.id, scanThresholdDbm: -70 } })).json();
      expect(plan.scanExclusions).toBe(1);
      const bad = await request.post('/api/coordination/plan', { data: { scanId: scan.id } });
      expect(bad.status()).toBe(400);
    } finally {
      await request.delete(`/api/scans/${scan.id}`);
    }
    expect((await request.get(`/api/scans/${scan.id}`)).status()).toBe(404);
  });

  test('refuses a file with nothing in it', async ({ request }) => {
    const res = await request.post('/api/scans', { data: { name: 'x', text: 'just words\n' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('No frequency/level pairs');
  });

  test('the RF page offers the scan and the coordinator offers to keep out of it', async ({ page, request }) => {
    const scan = await (await request.post('/api/scans', { data: { name: 'House scan', text: WSM } })).json();
    try {
      await page.goto('/#/rf');
      const controls = page.getByRole('group', { name: 'Spectrum scan' });
      await expect(controls).toBeVisible();
      await controls.getByRole('combobox', { name: 'Scan to show' }).selectOption(scan.id);
      await expect(controls.getByText(/wsm · 25 kHz/)).toBeVisible();
      await expect(page.getByRole('region', { name: 'Frequency coordination' }).getByText(/Keep out of what “House scan” shows above/)).toBeVisible();
      // Survives a reload: the selection is this browser's.
      await page.reload();
      await expect(page.getByRole('group', { name: 'Spectrum scan' }).getByRole('combobox', { name: 'Scan to show' })).toHaveValue(scan.id);
    } finally {
      await request.delete(`/api/scans/${scan.id}`);
    }
  });
});
