import { test, expect } from '@playwright/test';
import { open, expectNoCrash, goLive, standDown } from './helpers';

// Every route renders. Deliberately the dullest test in the suite, and the one
// that would have caught the most: a Settings page that threw on a machine
// with no soundcard, a page that scrolled sideways, a blank screen after a
// tab woke up. All of them compiled.

const ROUTES: Array<{ path: string; heading: RegExp }> = [
  { path: '/',            heading: /Monitoring Dashboard|Ready when you are/ },
  { path: '/inventory',   heading: /Hardware Inventory/ },
  { path: '/rf',          heading: /RF Environment/ },
  { path: '/battery',     heading: /Battery/ },
  { path: '/settings',    heading: /Settings/i },
  { path: '/shows',       heading: /Shows/ },
  { path: '/performers',  heading: /Performers/ },
  { path: '/detections',  heading: /Detections/ },
];

test.describe('every page renders', () => {
  for (const route of ROUTES) {
    test(`${route.path} renders without crashing`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('pageerror', err => consoleErrors.push(err.message));

      await open(page, route.path);
      await expect(page.getByText(route.heading).first()).toBeVisible();
      await expectNoCrash(page);

      // An uncaught exception that a boundary happened to swallow is still a
      // defect; the boundary is a safety net, not a licence.
      expect(consoleErrors, `uncaught errors on ${route.path}`).toEqual([]);
    });
  }

  test('the full-screen views render outside the sidebar shell', async ({ page }) => {
    await open(page, '/micboard');
    await expectNoCrash(page);
    // No sidebar: these are wall displays, not operator pages.
    await expect(page.locator('.sidebar')).toHaveCount(0);

    await open(page, '/backstage');
    await expectNoCrash(page);
  });

  test('an unknown path serves the app shell rather than a 404', async ({ request }) => {
    // The SPA fallback. Asserted at the HTTP level rather than by loading it:
    // the bundle is built with a relative base, so assets under a deep path
    // resolve relative to that path and do not load. That costs nothing in
    // practice — the app uses hash routing, so every real URL is "/" or
    // "/#/route" — but it does mean a deep path serves HTML that cannot boot.
    const res = await request.get('/some/deep/link');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  test('an unknown hash route still boots the app', async ({ page }) => {
    // The realistic case: a stale bookmark to a route that no longer exists.
    await page.goto('/#/no-such-page');
    await expect(page.locator('#root')).not.toBeEmpty();
  });
});

test.describe('navigating between pages', () => {
  test.beforeEach(async ({ request }) => {
    // The dashboard is the Go Live screen until the rig is live, and the nav
    // is what this test is about.
    await goLive(request, null);
  });
  test.afterEach(async ({ request }) => { await standDown(request); });

  test('every sidebar link reaches its page', async ({ page }) => {
    await open(page, '/');

    for (const [label, expected] of [
      ['Inventory', /Hardware Inventory/],
      ['RF Environment', /RF Environment/],
      ['Battery Management', /Battery/],
      ['Performers', /Performers/],
      ['Detections', /Detections/],
      ['Settings', /Settings/i],
    ] as const) {
      await page.getByRole('link', { name: label }).click();
      await expect(page.getByText(expected).first()).toBeVisible();
      await expectNoCrash(page);
    }
  });
});
