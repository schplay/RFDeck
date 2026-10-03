import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import selfsigned from 'selfsigned';
import { log } from './logger';

// TLS for every RFDeck deployment, not only the ones somebody configured.
//
// This used to read TLS_KEY/TLS_CERT and return null — "serve plain HTTP, which
// stays a valid deployment" — and the consequence was that TLS was a property of
// the *installer* rather than of the product. The scripted install generated a
// certificate; the desktop build and any manual install served the venue network
// in clear text on port 3000, deliberately, for every client on it.
//
// That was an acceptable trade while the only secret crossing the wire was the
// PIN token: install-scoped, revocable locally, worthless off the LAN. It stopped
// being acceptable when the Manifold cloud-login flow arrived, because the Meros
// login token it carries redeems into a **one-year refresh token** for somebody's
// cloud account. A credential of that value cannot cross a venue network in
// plain text, and a venue network is where RFDeck lives.
//
// So an absent TLS_KEY/TLS_CERT now means "generate one", and there is one code
// path for the installer, the desktop build, a manual install and a checkout.
//
// Browsers also withhold `navigator.mediaDevices` from pages served over plain
// HTTP to a network address, so audio monitoring for anyone but the person at the
// server has always depended on this. That was the original reason for the file
// and it is still true; it is no longer the main one.

export interface TlsConfig {
  key: Buffer;
  cert: Buffer;
  /**
   * SHA-256 of the DER-encoded SubjectPublicKeyInfo, lowercase hex.
   *
   * This is what Manifold pins and what the operator confirms at pairing. The
   * **public key**, deliberately, not the certificate: a certificate is
   * regenerated whenever the machine's address set changes, which on DHCP it
   * will, and a pin that broke every time a lease moved is a pin nobody keeps.
   * The key is generated once and kept, so only a genuine key change — a
   * reinstall, a new machine, or an attack — breaks the pin, which is exactly
   * the set of events that should.
   */
  spki: string;
  /** Where the generated pair lives, or null when it was configured explicitly. */
  dir: string | null;
}

const KEY_FILE = 'rfdeck-key.pem';
const CERT_FILE = 'rfdeck-cert.pem';
const SAN_FILE = 'rfdeck-cert.sans';

/**
 * Every name and address this machine answers on.
 *
 * A certificate that does not cover the address a client typed produces a
 * different browser warning from the self-signed one — and, worse, breaks
 * Manifold's hostname check even when the pin matches. Collected fresh on every
 * start, which is also how a DHCP move is noticed.
 */
export function localSubjectNames(
  hostname: string = os.hostname(),
  interfaces: Record<string, os.NetworkInterfaceInfo[] | undefined> = os.networkInterfaces(),
): { dns: string[]; ips: string[] } {
  const dns = new Set<string>(['localhost']);
  const ips = new Set<string>(['127.0.0.1', '::1']);

  const short = hostname.split('.')[0];
  if (short) {
    dns.add(short);
    // Bonjour/mDNS is how RFDeck is usually reached by name on a show network,
    // and it is a different name from the bare hostname.
    dns.add(`${short}.local`);
  }
  if (hostname !== short) dns.add(hostname);

  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.internal) continue;
      ips.add(iface.address);
    }
  }

  return { dns: [...dns].sort(), ips: [...ips].sort() };
}

/** The pin: SHA-256 over the DER SubjectPublicKeyInfo of this key. */
export function spkiFingerprint(keyPem: string | Buffer): string {
  const der = crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

/**
 * The short form an operator reads off a screen.
 *
 * Confirming 64 hex characters by eye is a step people skip, and a check people
 * skip is not a check. Eight groups of four from the start of the digest is
 * comparable at a glance and still 128 bits, which is far beyond what anyone
 * could steer a generated key towards.
 */
export function shortFingerprint(spki: string): string {
  return (spki.match(/.{4}/g) ?? []).slice(0, 8).join('-').toUpperCase();
}

/** Explicitly configured key and certificate, or null when none is. */
function configured(): TlsConfig | null {
  const keyPath = process.env.TLS_KEY?.trim();
  const certPath = process.env.TLS_CERT?.trim();
  if (!keyPath && !certPath) return null;

  // Half-configured is a mistake worth naming rather than silently ignoring.
  if (!keyPath || !certPath) {
    log.error(
      'TLS is half-configured: both TLS_KEY and TLS_CERT are required. ' +
      'Generating a certificate instead of using the one you asked for.',
    );
    return null;
  }

  try {
    const key = fs.readFileSync(keyPath);
    return { key, cert: fs.readFileSync(certPath), spki: spkiFingerprint(key), dir: null };
  } catch (err: any) {
    // Falling back to a generated certificate here would quietly ignore a
    // deployment that asked for a specific one — including a real CA-issued
    // certificate — and the first sign would be a pin mismatch at Manifold.
    log.error(
      `Could not read the TLS certificate or key (${err?.message}). ` +
      'Refusing to start rather than serving a different identity than configured.',
    );
    process.exit(1);
  }
}

/** The names a stored certificate was built for, so a move can be noticed. */
function readSans(dir: string): string | null {
  try { return fs.readFileSync(path.join(dir, SAN_FILE), 'utf8').trim(); }
  catch { return null; }
}

function sanSignature(names: { dns: string[]; ips: string[] }): string {
  return [...names.dns, ...names.ips].join(',');
}

/**
 * Load, or make, this install's key and certificate.
 *
 * `dir` is where the pair is kept — beside the database, so it shares the
 * database's backup and permissions story rather than inventing its own.
 */
export async function loadTlsConfig(dir: string = defaultTlsDir()): Promise<TlsConfig> {
  const explicit = configured();
  if (explicit) {
    log.info(`[TLS] Using the configured certificate. Fingerprint ${shortFingerprint(explicit.spki)}`);
    return explicit;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, KEY_FILE);
  const certPath = path.join(dir, CERT_FILE);

  const names = localSubjectNames();
  const wanted = sanSignature(names);

  // The key is reused even when the certificate is not, so the pin survives.
  let keyPem: string | null = null;
  try { keyPem = fs.readFileSync(keyPath, 'utf8'); } catch { /* first start */ }

  if (keyPem) {
    const haveCert = fs.existsSync(certPath);
    const sansMatch = readSans(dir) === wanted;
    if (haveCert && sansMatch && !expiringSoon(certPath)) {
      const cert = fs.readFileSync(certPath);
      const spki = spkiFingerprint(keyPem);
      log.info(`[TLS] Serving HTTPS with this install's certificate. Fingerprint ${shortFingerprint(spki)}`);
      return { key: Buffer.from(keyPem), cert, spki, dir };
    }
    if (haveCert && !sansMatch) {
      log.info(
        '[TLS] This machine answers on different addresses than when the certificate ' +
        'was made; reissuing it. The key is unchanged, so the fingerprint Manifold ' +
        'pinned still matches.',
      );
    }
  }

  return await generate(dir, keyPath, certPath, names, keyPem);
}

/** Within thirty days of expiry, so a long-running install reissues in good time. */
function expiringSoon(certPath: string): boolean {
  try {
    const notAfter = new crypto.X509Certificate(fs.readFileSync(certPath)).validTo;
    const days = (new Date(notAfter).getTime() - Date.now()) / 86_400_000;
    if (days < 30) {
      log.info(`[TLS] The certificate expires in ${Math.round(days)} day(s); reissuing it.`);
      return true;
    }
    return false;
  } catch {
    // Unparseable, so it cannot be trusted to be valid. Replace it.
    return true;
  }
}

async function generate(
  dir: string,
  keyPath: string,
  certPath: string,
  names: { dns: string[]; ips: string[] },
  existingKey: string | null,
): Promise<TlsConfig> {
  const altNames = [
    ...names.dns.map(value => ({ type: 2, value })),     // dNSName
    ...names.ips.map(value => ({ type: 7, ip: value })), // iPAddress
  ];

  // Ten years, set as an explicit date.
  //
  // `selfsigned`'s `days` option is accepted and ignored in 5.5.0 — it hardcodes
  // 365 days unless `notAfterDate` is given (index.js:285-291). Passing `days`
  // and trusting it would have produced one-year certificates while this comment
  // claimed ten, and the first symptom would be a show server failing its own
  // TLS a year after anyone last touched it.
  //
  // Long on purpose: this certificate's trust comes from the pinned key, not from
  // an expiry date, so a short lifetime buys nothing and risks a reissue
  // mid-season. `expiringSoon` reissues at thirty days regardless, and because
  // the key is reused the pin survives that.
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);

  // Only the private key is persisted; the public half is derived from it, which
  // is also the cheapest proof that the two belong together.
  const keyPair = existingKey
    ? {
        privateKey: existingKey,
        publicKey: crypto.createPublicKey(existingKey)
          .export({ type: 'spki', format: 'pem' }).toString(),
      }
    : undefined;

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: names.dns[0] ?? 'rfdeck' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate,
      extensions: [{ name: 'subjectAltName', altNames }],
      ...(keyPair ? { keyPair } : {}),
    } as any,
  );

  // Verified rather than assumed. A silently rotated key would break every pin
  // and look exactly like an attack from Manifold's side, so if it ever happens
  // it has to be said out loud rather than discovered at the rig.
  if (existingKey && spkiFingerprint(pems.private) !== spkiFingerprint(existingKey)) {
    log.warn(
      "[TLS] This install's key changed while reissuing the certificate. Manifold " +
      'and any other paired client will report a fingerprint mismatch and must be ' +
      'paired again. This is not expected — please report it.',
    );
  }

  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, SAN_FILE), sanSignature(names), { mode: 0o644 });

  const spki = spkiFingerprint(pems.private);
  log.warn(
    `[TLS] Generated this install's certificate, covering ${names.dns.join(', ')} and ` +
    `${names.ips.join(', ')}. Fingerprint ${shortFingerprint(spki)} — confirm this when ` +
    'pairing Manifold or any other client.',
  );
  return { key: Buffer.from(pems.private), cert: Buffer.from(pems.cert), spki, dir };
}

/**
 * Beside the database, which is the one directory every deployment already has
 * and already treats as this install's own state.
 */
export function defaultTlsDir(): string {
  const url = process.env.DATABASE_URL ?? '';
  const file = url.startsWith('file:') ? url.slice('file:'.length) : '';
  if (file) return path.dirname(path.resolve(file));
  return path.resolve(process.env.RFDECK_DATA_DIR ?? process.cwd());
}
