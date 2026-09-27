import { test, expect } from '@playwright/test';

// Alerts that leave the browser.
//
// Browser push is the only alert channel the application owns: no account, no bill,
// the browser's own push service does the delivery and RFDeck only signs. Webhooks,
// email and SMS are delivered by Meros from rules configured there over RFDeck's
// event stream, so there is nothing local to test for them.
//
// This file used to test a local webhook implementation — delivery against a real
// listener, signing, failure recording. That feature was removed on 2026-09-27
// because the cloud delivers webhooks from the same events, and two implementations
// of one feature only disagree about what was sent. The tests went with it, and the
// first describe below replaces them: it asserts the routes are actually gone, which
// is the part worth keeping now.

test.describe('the removed webhook routes', () => {
  // A deletion nobody checks is a deletion that comes back. These are cheap, and
  // they would catch a revert or a half-finished re-introduction.
  test('are not served any more', async ({ request }) => {
    const gone = [
      await request.get('/api/notifications/webhooks'),
      await request.post('/api/notifications/webhooks', { data: { url: 'http://127.0.0.1:1/x' } }),
    ];
    for (const res of gone) {
      // 404 from the router, never a 200 with an empty list — that would mean the
      // routes survived and only the UI went.
      expect(res.status()).toBe(404);
    }
  });
});

test.describe('the notifications settings tab', () => {
  test('is on the alerts tab', async ({ page }) => {
    await page.goto('/#/settings?tab=alerts');
    await expect(page.getByRole('heading', { name: /Notifications/ })).toBeVisible();
  });

  test('says where the channels it no longer owns have gone', async ({ page }) => {
    // An operator who expects webhooks should find out they are configured in the
    // cloud, rather than concluding RFDeck cannot do it at all.
    await page.goto('/#/settings?tab=alerts');
    await expect(page.getByText(/Webhooks, email and SMS are configured in your Meros account/i))
      .toBeVisible();
  });
});

test.describe('browser push', () => {
  test('publishes a public key and never the private one', async ({ request }) => {
    const { publicKey } = await (await request.get('/api/notifications/push/key')).json();
    expect(typeof publicKey).toBe('string');
    expect(publicKey.length).toBeGreaterThan(40);

    const settings = await (await request.get('/api/settings')).json();
    expect(settings.vapidPrivateKey).toBeUndefined();
    expect(settings.vapidPublicKey).toBeUndefined();
  });

  test('the key is stable across requests, since every subscription is bound to it', async ({ request }) => {
    const a = (await (await request.get('/api/notifications/push/key')).json()).publicKey;
    const b = (await (await request.get('/api/notifications/push/key')).json()).publicKey;
    expect(a).toBe(b);
  });

  test('stores a subscription without exposing its endpoint, and removes it on request', async ({ request }) => {
    const sub = {
      endpoint: 'https://push.example.invalid/send/abc123',
      keys: { p256dh: 'BPUBLIC', auth: 'AUTH' },
    };
    const saved = await (await request.post('/api/notifications/push/subscribe', {
      data: { subscription: sub, label: 'test browser' },
    })).json();
    expect(saved.endpoint).toBeUndefined();
    expect(saved.endpointHost).toBe('push.example.invalid');
    expect(saved.minSeverity).toBe('CRITICAL');

    const res = await request.post('/api/notifications/push/unsubscribe', { data: { endpoint: sub.endpoint } });
    expect(res.status()).toBe(204);
    const list = await (await request.get('/api/notifications/push/subscriptions')).json();
    expect(list.find((s: any) => s.id === saved.id)).toBeUndefined();
  });

  test('rejects a subscription with no keys', async ({ request }) => {
    const res = await request.post('/api/notifications/push/subscribe', {
      data: { subscription: { endpoint: 'https://push.example.invalid/x' } },
    });
    expect(res.status()).toBe(400);
  });
});
