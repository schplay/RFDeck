import { test, expect } from '@playwright/test';
import http from 'http';
import { AddressInfo } from 'net';

// Alerts that leave the browser — the free half of C.2.
//
// Delivery is exercised against a real listener started inside the test,
// because the thing worth knowing is that a POST actually arrives, signed,
// with the alert in it. And the failures are exercised too: a webhook that is
// failing has to say so in the list, or an operator finds out on the night
// nothing arrived.

async function receiver() {
  const hits: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      hits.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/alerts`, hits, close: () => server.close() };
}

test.describe('webhooks', () => {
  test('a test alert arrives at the URL, signed, and the result is recorded', async ({ request }) => {
    const rx = await receiver();
    try {
      const hook = await (await request.post('/api/notifications/webhooks', {
        data: { name: 'Test receiver', url: rx.url, secret: 'shh' },
      })).json();
      expect(hook.hasSecret).toBe(true);
      expect(hook.minSeverity).toBe('CRITICAL');   // the quiet default

      const r = await (await request.post(`/api/notifications/webhooks/${hook.id}/test`)).json();
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);

      expect(rx.hits).toHaveLength(1);
      expect(rx.hits[0].body.event).toBe('test');
      expect(rx.hits[0].body.alert.message).toMatch(/Test from RFDeck/);
      expect(rx.hits[0].headers['x-rfdeck-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

      const listed = (await (await request.get('/api/notifications/webhooks')).json())
        .find((h: any) => h.id === hook.id);
      expect(listed.lastStatus).toBe(200);
      expect(listed.lastError).toBeNull();
      expect(listed.failures).toBe(0);
      // Never the secret itself.
      expect(listed.secret).toBeUndefined();

      await request.delete(`/api/notifications/webhooks/${hook.id}`);
    } finally { rx.close(); }
  });

  test('a failing webhook says so in the list', async ({ request }) => {
    // Port 1 is never listening.
    const hook = await (await request.post('/api/notifications/webhooks', {
      data: { name: 'Dead', url: 'http://127.0.0.1:1/x' },
    })).json();
    try {
      const r = await (await request.post(`/api/notifications/webhooks/${hook.id}/test`)).json();
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();

      const listed = (await (await request.get('/api/notifications/webhooks')).json())
        .find((h: any) => h.id === hook.id);
      expect(listed.failures).toBe(1);
      expect(listed.lastError).toBeTruthy();
    } finally { await request.delete(`/api/notifications/webhooks/${hook.id}`); }
  });

  test('refuses a URL that is not http or https', async ({ request }) => {
    for (const url of ['ftp://x', 'not a url', 'javascript:alert(1)']) {
      const res = await request.post('/api/notifications/webhooks', { data: { url } });
      expect(res.status(), url).toBe(400);
    }
  });

  test('editing the name leaves the secret alone', async ({ request }) => {
    const hook = await (await request.post('/api/notifications/webhooks', {
      data: { url: 'http://127.0.0.1:1/x', secret: 'keep-me' },
    })).json();
    try {
      const after = await (await request.put(`/api/notifications/webhooks/${hook.id}`, {
        data: { name: 'Renamed' },
      })).json();
      expect(after.name).toBe('Renamed');
      expect(after.hasSecret).toBe(true);

      const cleared = await (await request.put(`/api/notifications/webhooks/${hook.id}`, {
        data: { secret: null },
      })).json();
      expect(cleared.hasSecret).toBe(false);
    } finally { await request.delete(`/api/notifications/webhooks/${hook.id}`); }
  });

  test('is on the alerts tab', async ({ page }) => {
    await page.goto('/#/settings?tab=alerts');
    await expect(page.getByRole('heading', { name: /Notifications/ })).toBeVisible();
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
