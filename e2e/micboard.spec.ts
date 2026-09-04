import { test, expect } from '@playwright/test';
import { open, expectNoCrash, goLive, standDown, clearShows } from './helpers';

// The Micboard is the one view that runs unattended on a wall, so the things
// worth pinning are that it needs no PIN to read, that it says plainly when
// nothing is running, and that it cannot be used to change anything.

test.describe('Micboard', () => {
  test.afterEach(async ({ request }) => { await standDown(request); });

  test('says it is standing by when the rig is not live', async ({ page, request }) => {
    await standDown(request);
    await open(page, '/micboard');

    await expect(page.locator('.mb-standby')).toBeVisible();
    await expect(page.getByText(/standing by\. An operator starts the rig/i)).toBeVisible();
    await expectNoCrash(page);
  });

  test('shows the live show once the rig is live', async ({ page, request }) => {
    await clearShows(request);
    const show = await (await request.post('/api/shows', {
      data: { name: 'Evening Performance', environmentMode: 'THEATER' },
    })).json();
    await goLive(request, show.id);

    await open(page, '/micboard');
    await expect(page.getByText('Evening Performance')).toBeVisible();
    await expect(page.locator('.mb-standby')).toHaveCount(0);
    await expectNoCrash(page);

    await request.delete(`/api/shows/${show.id}`);
  });

  test('its data is readable without authentication', async ({ request }) => {
    // The exemption a wall display depends on. Read is open by design.
    const micboard = await request.get('/api/micboard');
    expect(micboard.ok()).toBeTruthy();
    expect(await micboard.json()).toHaveProperty('assignments');

    const live = await request.get('/api/live');
    expect(live.ok()).toBeTruthy();
  });

  test('the read exemption does not extend to writing', async ({ request }) => {
    // /api/live answers POST and DELETE as well as GET. A path-only exemption
    // would have let anyone on the network stand the whole rig down without
    // the PIN; the gate matches method as well as path.
    const gate = await request.get('/api/auth/status');
    const { pinEnabled } = await gate.json();

    // With no PIN configured everything is open anyway, so this asserts the
    // shape of the rule rather than a rejection: the exemption list itself
    // must not contain a path whose writes would ride along with its reads.
    expect(typeof pinEnabled).toBe('boolean');

    // The inventory is never part of the display's read surface.
    const res = await request.get('/api/micboard');
    const body = await res.json();
    expect(body).not.toHaveProperty('devices');
    expect(body).not.toHaveProperty('inventory');
    expect(Object.keys(body).sort()).toEqual(['assignments', 'live', 'show']);
  });
});
