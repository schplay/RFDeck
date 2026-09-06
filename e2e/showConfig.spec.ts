import { test, expect, APIRequestContext } from '@playwright/test';

// How many acts, services or sets a production runs to.
//
// This was fixed at four for every show, which is a theatre assumption and
// wrong nearly everywhere else: a worship service is usually one, a festival is
// however many bands are booked. The mic check is per period, so the count
// decides whether an operator gets tabs they can never fill in or periods they
// cannot check at all — and it was not settable at creation or afterwards.

async function newShow(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  const res = await request.post('/api/shows', {
    data: { name: `Config ${Math.random().toString(36).slice(2, 8)}`, ...fields },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function remove(request: APIRequestContext, id: string) {
  await request.delete(`/api/shows/${id}`);
}

test.describe('a show carries its own period count', () => {
  test('defaults to four when nothing is asked for', async ({ request }) => {
    const show = await newShow(request);
    try {
      expect(show.periodCount).toBe(4);
    } finally { await remove(request, show.id); }
  });

  test('is set at creation', async ({ request }) => {
    // The case that prompted this: one service, not four acts.
    const show = await newShow(request, { environmentMode: 'HOUSE_OF_WORSHIP', periodCount: 1 });
    try {
      expect(show.environmentMode).toBe('HOUSE_OF_WORSHIP');
      expect(show.periodCount).toBe(1);
    } finally { await remove(request, show.id); }
  });

  test('is editable afterwards, and the change is readable back', async ({ request }) => {
    const show = await newShow(request, { periodCount: 2 });
    try {
      const updated = await (await request.put(`/api/shows/${show.id}`, {
        data: { periodCount: 6 },
      })).json();
      expect(updated.periodCount).toBe(6);

      const all = await (await request.get('/api/shows')).json();
      expect(all.find((s: any) => s.id === show.id).periodCount).toBe(6);
    } finally { await remove(request, show.id); }
  });

  test('refuses a count that would leave nowhere to check a microphone', async ({ request }) => {
    // Zero and negative are easy to type and impossible to recover from in the
    // UI, so they are clamped rather than stored.
    for (const asked of [0, -3]) {
      const show = await newShow(request, { periodCount: asked });
      try {
        expect(show.periodCount).toBe(1);
      } finally { await remove(request, show.id); }
    }
  });

  test('refuses an absurd count rather than rendering a wall of tabs', async ({ request }) => {
    const show = await newShow(request, { periodCount: 9999 });
    try {
      expect(show.periodCount).toBe(12);
    } finally { await remove(request, show.id); }
  });

  test('ignores a non-numeric count instead of storing NaN', async ({ request }) => {
    const show = await newShow(request, { periodCount: 'lots' });
    try {
      expect(show.periodCount).toBe(4);
    } finally { await remove(request, show.id); }
  });

  test('lowering the count keeps checks already recorded beyond it', async ({ request }) => {
    // Reducing the count is a display decision, not a delete. An operator who
    // trims a show to two acts must not silently lose act 3's soundcheck.
    const show = await newShow(request, { periodCount: 4 });
    try {
      await request.put(`/api/shows/${show.id}/check`, {
        data: { act: 3, channelKey: 'row-abc:1', checked: true },
      });
      await request.put(`/api/shows/${show.id}`, { data: { periodCount: 2 } });

      const all = await (await request.get('/api/shows')).json();
      const after = all.find((s: any) => s.id === show.id);
      expect(after.periodCount).toBe(2);
      expect(after.micCheck.acts['3']?.['row-abc:1']?.checked).toBe(true);
    } finally { await remove(request, show.id); }
  });
});
