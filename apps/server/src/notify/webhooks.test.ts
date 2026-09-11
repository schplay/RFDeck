import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { signBody, webhookBody, deliver, DELIVERY_TIMEOUT_MS } from './webhooks';

// Webhook delivery, against a real listener.
//
// The signature is what lets a receiver trust the POST, so it is checked the
// way a receiver would check it. Delivery is exercised against an actual HTTP
// server rather than a mocked fetch: what matters is that a refused
// connection, a slow server and a 500 all come back as an honest result rather
// than as a thrown error that kills the dispatcher.

const sample = {
  id: 'a1', timestamp: '2026-09-11T20:00:00.000Z', severity: 'CRITICAL',
  type: 'DROPOUT', message: 'RF dropout on Vocal 1',
};

describe('the signature', () => {
  it('is HMAC-SHA256 over the exact body, hex, prefixed', () => {
    const body = webhookBody(sample);
    const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(signBody(body, 's3cret')).toBe(expected);
  });

  it('changes if a single byte of the body changes', () => {
    const a = signBody('{"x":1}', 'k');
    const b = signBody('{"x":2}', 'k');
    expect(a).not.toBe(b);
  });
});

describe('the body', () => {
  it('names the event and carries the alert unchanged', () => {
    const parsed = JSON.parse(webhookBody(sample));
    expect(parsed.event).toBe('alert');
    expect(parsed.alert).toEqual(sample);
    expect(typeof parsed.sentAt).toBe('string');
  });
});

async function listen(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hook`, close: () => server.close() };
}

describe('delivery', () => {
  it('posts the body with the signature, and reports the status', async () => {
    let got: { sig?: string; body: string } | null = null;
    const srv = await listen((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        got = { sig: req.headers['x-rfdeck-signature'] as string, body };
        res.writeHead(204); res.end();
      });
    });
    try {
      const body = webhookBody(sample);
      const r = await deliver(srv.url, body, 'k');
      expect(r).toEqual({ ok: true, status: 204, error: null });
      expect(got!.body).toBe(body);
      expect(got!.sig).toBe(signBody(body, 'k'));
    } finally { srv.close(); }
  });

  it('sends no signature header when there is no secret', async () => {
    let sig: string | undefined = 'unset';
    const srv = await listen((req, res) => {
      sig = req.headers['x-rfdeck-signature'] as string | undefined;
      res.writeHead(200); res.end();
    });
    try {
      await deliver(srv.url, '{}', null);
      expect(sig).toBeUndefined();
    } finally { srv.close(); }
  });

  it('reports a server error as a result, not a throw', async () => {
    const srv = await listen((_req, res) => { res.writeHead(502); res.end(); });
    try {
      const r = await deliver(srv.url, '{}', null);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(502);
      expect(r.error).toBe('HTTP 502');
    } finally { srv.close(); }
  });

  it('reports a refused connection as a result, not a throw', async () => {
    // Port 1 is never listening.
    const r = await deliver('http://127.0.0.1:1/hook', '{}', null);
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('gives up on a server that never answers', async () => {
    const srv = await listen(() => { /* never respond */ });
    try {
      const t0 = Date.now();
      const r = await deliver(srv.url, '{}', null);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/No response within/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(DELIVERY_TIMEOUT_MS - 50);
    } finally { srv.close(); }
  }, DELIVERY_TIMEOUT_MS + 3_000);
});
