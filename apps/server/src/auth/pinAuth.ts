import crypto from 'crypto';
import { prisma } from '../db';

// ── PIN access control ──
//
// RFDeck defaults to an open, trusted show network: no PIN, all connections
// allowed. An admin can enable a PIN that REMOTE clients must present.
//
// Two deliberate carve-outs:
//   • Loopback is always trusted. Physical access to the host already implies
//     control, and the desktop window must never be locked out of its own server.
//   • Token lifetime is admin-configured. authReauthHours = 0 means a device
//     authenticates once and is not prompted again, which is what a resident
//     install in a booth wants.

export interface AuthState {
  enabled: boolean;
  reauthHours: number;
}

// Issued tokens → expiry (epoch ms; Infinity when re-auth is disabled).
// In-memory by design: a server restart re-prompts remote clients, which is
// the safer default and costs nothing at this scale (1–10 concurrent users).
const tokens = new Map<string, number>();

function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

// Stored as salt:hash so the salt travels with the record.
export function makePinHash(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${hashPin(pin, salt)}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = hashPin(pin, salt);
  // Constant-time compare — the PIN space is small, so a timing oracle would
  // meaningfully help an attacker on a shared network.
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The salt a client needs in order to derive the same key the server stores.
 *
 * Salts are not secret - their job is to stop one precomputed table covering
 * every install, and publishing this one does not help against that. It is
 * handed out unauthenticated because a client has to have it *before* it can
 * authenticate, which is the whole point of the exchange below.
 */
export function pinSalt(stored: string | null | undefined): string | null {
  const salt = (stored ?? '').split(':')[0];
  return salt || null;
}

/**
 * Verify a PIN proof that is bound to the TLS certificate the client reached.
 *
 * The problem this solves: RFDeck generates its own certificate, so a client has
 * no certificate authority to appeal to and accepting any self-signed
 * certificate is indistinguishable from accepting a man in the middle. Sending
 * the fingerprint the client observed alongside the PIN does not help - an
 * attacker who terminated TLS sees the request in plain text and can rewrite the
 * fingerprint to the real server's before forwarding it.
 *
 * So the fingerprint has to be *cryptographically bound* to knowledge of the
 * PIN:
 *
 *   k     = scrypt(PIN, salt)                 - the value the server already stores
 *   proof = HMAC-SHA256(k, fingerprint_seen)
 *
 * The server recomputes with the fingerprint of its *own* certificate. A man in
 * the middle presenting its own key makes the two differ, so the proof fails,
 * and it cannot forge one without `k`. The PIN also stops crossing the network
 * in a replayable form, which is worth having by itself.
 *
 * `k` is the stored hash rather than the PIN, so this needs no reversible secret
 * at rest - the server never has to know the PIN to check the binding.
 *
 * **The limit, stated because it is real:** a four-digit PIN is 10,000
 * candidates. An attacker who is actively in the middle at the one pairing
 * moment captures a proof, knows the salt and the fingerprint it presented, and
 * can search that space offline whatever the KDF costs. PIN length is a
 * deliberate product decision (speed and ease of use come first, and PINs are
 * not used in every scenario), so this is not the anchor of the trust model -
 * the operator confirming the fingerprint RFDeck displays is. This makes the
 * common case safe and the attack narrow; it does not make it impossible.
 */
export function verifyPinProof(
  proof: string | undefined,
  stored: string | null | undefined,
  fingerprint: string,
): boolean {
  if (!proof || !stored || !fingerprint) return false;
  const [, key] = stored.split(':');
  if (!key) return false;

  const expected = crypto.createHmac('sha256', Buffer.from(key, 'hex'))
    .update(fingerprint.toLowerCase())
    .digest();
  let given: Buffer;
  try { given = Buffer.from(proof, 'hex'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export async function getAuthState(): Promise<AuthState> {
  const settings = await prisma.settings.findFirst();
  return {
    enabled:     settings?.authPinEnabled ?? false,
    reauthHours: settings?.authReauthHours ?? 0,
  };
}

export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const addr = ip.replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost';
}

export function issueToken(reauthHours: number): string {
  const token = crypto.randomBytes(24).toString('hex');
  const expiry = reauthHours > 0 ? Date.now() + reauthHours * 3600_000 : Infinity;
  tokens.set(token, expiry);
  return token;
}

export function isTokenValid(token: string | undefined): boolean {
  if (!token) return false;
  const expiry = tokens.get(token);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    tokens.delete(token);
    return false;
  }
  return true;
}

export function revokeAllTokens(): void {
  tokens.clear();
}

// Is this request allowed through? Open when the PIN is off, always open from
// loopback, otherwise requires a live token.
export async function isRequestAuthorized(
  ip: string | undefined,
  token: string | undefined,
): Promise<boolean> {
  const { enabled } = await getAuthState();
  if (!enabled) return true;
  if (isLoopback(ip)) return true;
  return isTokenValid(token);
}
