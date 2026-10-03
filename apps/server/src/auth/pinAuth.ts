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

/**
 * Per-address throttle on PIN attempts.
 *
 * A four-digit PIN is 10,000 candidates. Without this, an unthrottled endpoint on
 * a venue network is the cheapest way into a rig there is - a few seconds of
 * requests, not a cryptographic attack. The PIN length is a deliberate product
 * choice, which makes the throttle the thing carrying that choice.
 *
 * Counts failures only, so a client with the right PIN is never delayed, and
 * clears on success so one fat-fingered operator does not lock themselves out for
 * the evening. Keyed per address: one misconfigured console cannot lock out the
 * booth. In memory, like the token table, so a restart forgives - acceptable
 * because a restart is not something an attacker on the network can cause.
 */
const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;
const failures = new Map<string, number[]>();

/** How long this address must wait, or 0 if it may try now. */
export function pinRetryAfterMs(ip: string | undefined): number {
  const recent = (failures.get(ip ?? '') ?? []).filter(t => Date.now() - t < FAIL_WINDOW_MS);
  if (recent.length < FAIL_LIMIT) return 0;
  return FAIL_WINDOW_MS - (Date.now() - recent[0]);
}

export function notePinFailure(ip: string | undefined): void {
  const key = ip ?? '';
  const recent = (failures.get(key) ?? []).filter(t => Date.now() - t < FAIL_WINDOW_MS);
  recent.push(Date.now());
  failures.set(key, recent);
}

export function clearPinFailures(ip: string | undefined): void {
  failures.delete(ip ?? '');
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
