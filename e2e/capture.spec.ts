import { test, expect } from '@playwright/test';

// Capture on request.
//
// Detections only record around something RFDeck itself noticed. This records
// because a person asked. What is tested here is the part that has to be honest
// without hardware: every way a capture can fail to start carries a reason,
// because a capture that quietly did not happen is found out after the show.

test.describe('asking for a capture', () => {
  test('refuses a length outside one to sixty minutes, and says so', async ({ request }) => {
    for (const minutes of [0, 61, -5, 'ten']) {
      const res = await request.post('/api/recording/capture', {
        data: { channelKey: 'row-abc:1', minutes },
      });
      expect(res.status(), `minutes=${minutes}`).toBe(400);
      expect((await res.json()).error).toMatch(/between 1 and 60/);
    }
  });

  test('requires a channel', async ({ request }) => {
    const res = await request.post('/api/recording/capture', { data: { minutes: 5 } });
    expect(res.status()).toBe(400);
  });

  test('says plainly when there is nothing to capture', async ({ request }) => {
    // The harness is not live, so recording is off; and no channel is patched.
    // Either way the answer has to name the cause rather than fail silently.
    const res = await request.post('/api/recording/capture', {
      data: { channelKey: 'row-abc:1', minutes: 5 },
    });
    expect([409, 503]).toContain(res.status());
    const { error } = await res.json();
    expect(error).toMatch(/not patched|Recording is off/);
  });

  test('stopping a capture that does not exist is a 404, not a silent success', async ({ request }) => {
    const res = await request.post('/api/recording/capture/nope/stop');
    expect(res.status()).toBe(404);
  });

  test('lists what is being captured, which is nothing until something is', async ({ request }) => {
    const res = await request.get('/api/recording/captures');
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual([]);
  });
});
