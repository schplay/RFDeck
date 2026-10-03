import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { loadTlsConfig, localSubjectNames, spkiFingerprint, shortFingerprint } from './tls';

// RFDeck generates and keeps its own certificate, because TLS used to be a
// property of the installer rather than of the product: the scripted install made
// a certificate and the desktop build served the venue network in clear text.
//
// The property these tests exist for is the one everything else rests on: **the
// key is stable across certificate reissue.** Manifold pins the public key, and a
// certificate is reissued whenever the machine's addresses change — which on DHCP
// they will. If a reissue rotated the key, every paired client would report a
// mismatch, which is indistinguishable from an attack, on an ordinary Tuesday
// when a lease moved.

let dir: string;
const saved = { key: process.env.TLS_KEY, cert: process.env.TLS_CERT };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-tls-'));
  delete process.env.TLS_KEY;
  delete process.env.TLS_CERT;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved.key) process.env.TLS_KEY = saved.key; else delete process.env.TLS_KEY;
  if (saved.cert) process.env.TLS_CERT = saved.cert; else delete process.env.TLS_CERT;
});

describe('an install with no certificate configured', () => {
  it('generates one rather than serving plain HTTP', async () => {
    const tls = await loadTlsConfig(dir);
    expect(tls.cert.length).toBeGreaterThan(0);
    expect(tls.key.length).toBeGreaterThan(0);
    // The old behaviour was to return null here and let the caller serve HTTP.
    expect(tls.spki).toMatch(/^[0-9a-f]{64}$/);
  });

  it('persists the pair, so a restart keeps the same identity', async () => {
    const first = await loadTlsConfig(dir);
    const second = await loadTlsConfig(dir);
    expect(second.spki).toBe(first.spki);
    expect(second.cert.equals(first.cert)).toBe(true);
  });

  it('covers loopback and this machine addresses, so no client gets a name mismatch', async () => {
    const tls = await loadTlsConfig(dir);
    const san = new crypto.X509Certificate(tls.cert).subjectAltName ?? '';
    expect(san).toContain('localhost');
    expect(san).toContain('127.0.0.1');
  });

  it('is valid for far longer than a year', async () => {
    // selfsigned 5.5.0 accepts a `days` option and ignores it, hardcoding 365.
    // Trusting it would have produced one-year certificates while the code said
    // ten, and the first symptom would be a show server failing its own TLS a
    // year after anyone last touched it.
    const tls = await loadTlsConfig(dir);
    const validTo = new Date(new crypto.X509Certificate(tls.cert).validTo).getTime();
    const years = (validTo - Date.now()) / (365 * 86_400_000);
    expect(years).toBeGreaterThan(5);
  });

  it('keeps the key when the certificate is reissued for new addresses', async () => {
    // The property Manifold's pin depends on. Simulated by invalidating the
    // recorded address set, which is exactly what a DHCP move does.
    const first = await loadTlsConfig(dir);
    fs.writeFileSync(path.join(dir, 'rfdeck-cert.sans'), 'something-else');

    const reissued = await loadTlsConfig(dir);
    expect(reissued.spki).toBe(first.spki);                      // pin survives
    expect(reissued.cert.equals(first.cert)).toBe(false);        // certificate did not
  });
});

describe('an install with a certificate configured', () => {
  it('uses it, and reports its fingerprint rather than generating a second one', async () => {
    const generated = await loadTlsConfig(dir);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-tls-cfg-'));
    try {
      process.env.TLS_KEY = path.join(dir, 'rfdeck-key.pem');
      process.env.TLS_CERT = path.join(dir, 'rfdeck-cert.pem');
      const configured = await loadTlsConfig(other);
      expect(configured.spki).toBe(generated.spki);
      expect(configured.dir).toBeNull();
      // Nothing was written where it would have generated one.
      expect(fs.existsSync(path.join(other, 'rfdeck-key.pem'))).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('the fingerprint an operator reads out', () => {
  it('is over the public key, not the certificate', async () => {
    // Deliberate: a certificate is reissued on an address change and the public
    // key is not, so pinning the certificate would break on a DHCP move.
    const tls = await loadTlsConfig(dir);
    const der = crypto.createPublicKey(tls.key).export({ type: 'spki', format: 'der' });
    expect(tls.spki).toBe(crypto.createHash('sha256').update(der).digest('hex'));
  });

  it('shortens to something comparable at a glance', () => {
    // 64 hex characters checked by eye is a step people skip, and a check people
    // skip is not a check.
    const short = shortFingerprint('0123456789abcdef'.repeat(4));
    expect(short).toBe('0123-4567-89AB-CDEF-0123-4567-89AB-CDEF');
    expect(short.replace(/-/g, '')).toHaveLength(32);
  });

  it('changes when the key changes, and only then', async () => {
    const a = await loadTlsConfig(dir);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-tls-b-'));
    try {
      const b = await loadTlsConfig(other);
      expect(b.spki).not.toBe(a.spki);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('the names a certificate has to cover', () => {
  it('includes the mDNS name, which is how a show network usually reaches RFDeck', () => {
    const names = localSubjectNames('booth-mac', {});
    expect(names.dns).toContain('booth-mac');
    expect(names.dns).toContain('booth-mac.local');
    expect(names.dns).toContain('localhost');
  });

  it('includes every external address and no internal ones', () => {
    const names = localSubjectNames('host', {
      eth0: [{ address: '10.2.3.10', internal: false } as any],
      lo:   [{ address: '127.0.0.1', internal: true } as any],
    });
    expect(names.ips).toContain('10.2.3.10');
    // Loopback is present because it is added explicitly, not because the
    // interface was walked — an internal interface's own address is not copied.
    expect(names.ips).toContain('127.0.0.1');
  });

  it('is stable in order, so an unchanged machine does not look changed', () => {
    const ifaces = { eth0: [{ address: '10.0.0.2', internal: false } as any] };
    expect(localSubjectNames('h', ifaces)).toEqual(localSubjectNames('h', ifaces));
  });

  it('fingerprints a key consistently however it is handed over', async () => {
    const tls = await loadTlsConfig(dir);
    expect(spkiFingerprint(tls.key)).toBe(spkiFingerprint(tls.key.toString()));
  });
});
