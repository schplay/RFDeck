import { test, expect } from '@playwright/test';

// The full event history export. The show report exports one show's events;
// this is everything the server has kept, offered from the RF page.

test.describe('event history export', () => {
  test('is offered on the RF page', async ({ page }) => {
    await page.goto('/#/rf');
    const link = page.getByRole('link', { name: 'Download the full event history as CSV' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /\/api\/events\/export/);
  });

  test('downloads as CSV, frequency columns included', async ({ request }) => {
    const res = await request.get('/api/events/export');
    expect(res.ok()).toBe(true);
    expect(res.headers()['content-type']).toContain('text/csv');
    expect(res.headers()['content-disposition']).toContain('attachment');
    const header = (await res.text()).split('\r\n')[0];
    expect(header).toBe('Timestamp,Source,Type,Severity,Channel,Device,RF A,RF B,From (MHz),To (MHz),Message,Acknowledged');
  });
});
