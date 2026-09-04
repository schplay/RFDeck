import { test, expect } from '@playwright/test';
import { open, expectNoCrash, standDown } from './helpers';

// Going live is now the way into everything, and it is a round trip through
// the API, the database, the device manager and the socket. If it breaks, the
// dashboard is empty and the Micboard is blank, with no obvious cause.

test.describe('Go Live', () => {
  test.beforeEach(async ({ request }) => { await standDown(request); });
  test.afterEach(async ({ request }) => { await standDown(request); });

  test('the dashboard offers Go Live until the rig is live', async ({ page }) => {
    await open(page, '/');

    // An empty dashboard with no explanation was the thing to avoid.
    await expect(page.getByRole('heading', { name: /Ready when you are/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Go Live/ })).toBeVisible();
    await expectNoCrash(page);
  });

  test('going live and standing down completes the round trip', async ({ page }) => {
    await open(page, '/');

    await page.getByRole('button', { name: /Go Live/ }).click();

    // The dashboard replaces the panel, and the sidebar says so.
    await expect(page.getByRole('heading', { name: 'Monitoring Dashboard' })).toBeVisible();
    await expect(page.locator('.live-indicator')).toBeVisible();
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
    await expectNoCrash(page);

    // Standing down asks first: it disables every device and stops recording.
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: /Stand Down/ }).click();

    await expect(page.getByRole('heading', { name: /Ready when you are/ })).toBeVisible();
    await expect(page.locator('.live-indicator')).toHaveCount(0);
  });

  test('standing down survives being cancelled', async ({ page, request }) => {
    await request.post('/api/live', { data: { showId: null } });
    await open(page, '/');
    await expect(page.locator('.live-indicator')).toBeVisible();

    // Dismissing the confirmation must leave the rig exactly as it was — this
    // is the click that would black out a dashboard mid-show.
    page.once('dialog', d => d.dismiss());
    await page.getByRole('button', { name: /Stand Down/ }).click();

    await expect(page.locator('.live-indicator')).toBeVisible();
    const state = await (await request.get('/api/live')).json();
    expect(state.live).toBe(true);
  });

  test('live state is server-held, so a second client agrees', async ({ page, request }) => {
    await request.post('/api/live', { data: { showId: null } });

    // A page opened fresh must see the state, not a local guess — an operator
    // and a wall display disagreeing about whether anything is running is the
    // failure this replaced.
    await open(page, '/');
    await expect(page.locator('.live-indicator')).toBeVisible();
  });

  test('the API refuses to go live with an archived show', async ({ request }) => {
    const show = await (await request.post('/api/shows', {
      data: { name: 'Closed Run', environmentMode: 'THEATER' },
    })).json();
    await request.put(`/api/shows/${show.id}`, { data: { archived: true } });

    const res = await request.post('/api/live', { data: { showId: show.id } });
    expect(res.status()).toBe(409);

    await request.delete(`/api/shows/${show.id}`);
  });
});
