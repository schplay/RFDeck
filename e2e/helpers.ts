import { expect, Page, APIRequestContext } from '@playwright/test';

// Shared moves for the end-to-end suite.

/**
 * Fail if a route rendered its error boundary.
 *
 * The boundaries exist so one bad panel does not black out the app mid-show —
 * which also means a crash now looks like a small card instead of a blank
 * page, and a test that only checked "something rendered" would pass. Every
 * navigation asserts this.
 */
export async function expectNoCrash(page: Page) {
  const boundary = page.locator('.eb-page, .eb-card');
  await expect(boundary).toHaveCount(0);
}

/** Reset the shared server between specs, so order cannot decide an outcome. */
export async function standDown(request: APIRequestContext) {
  await request.delete('/api/live');
}

export async function goLive(request: APIRequestContext, showId: string | null = null) {
  const res = await request.post('/api/live', { data: { showId } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Remove every show, so a spec starts from a known cast list. */
export async function clearShows(request: APIRequestContext) {
  const res = await request.get('/api/shows');
  if (!res.ok()) return;
  for (const show of await res.json()) {
    await request.delete(`/api/shows/${show.id}`);
  }
}

export async function clearPerformers(request: APIRequestContext) {
  const res = await request.get('/api/performers');
  if (!res.ok()) return;
  for (const p of await res.json()) {
    await request.delete(`/api/performers/${p.id}`);
  }
}

/**
 * Open a route and wait for the app to have mounted.
 *
 * The shell paints a splash before React runs, so "navigation finished" is not
 * "the page is usable" — waiting for the root to have real content is.
 */
export async function open(page: Page, hashRoute: string) {
  await page.goto(`/#${hashRoute}`);
  await expect(page.locator('#root')).not.toBeEmpty();
}
