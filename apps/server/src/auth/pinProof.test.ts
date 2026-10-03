import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  makePinHash, verifyPinProof, pinSalt,
  pinRetryAfterMs, notePinFailure, clearPinFailures,
} from './pinAuth';

// Binding a PIN login to the certificate the client actually reached.
//
// RFDeck generates its own certificate, so a client has no authority to appeal to
// and accepting any self-signed certificate is indistinguishable from accepting a
// man in the middle. The obvious design — send the observed fingerprint next to
// the PIN and have the server compare it — does not work at all: an attacker who
// terminated TLS reads the request in plain text and rewrites the fingerprint to
// the real server's before forwarding. These tests exist to stop that design
// being reintroduced as a simplification.

const FINGERPRINT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** What a client computes: HMAC over the fingerprint, keyed by the stored hash. */
function clientProof(stored: string, fingerprint: string): string {
  const key = stored.split(':')[1];
  return crypto.createHmac('sha256', Buffer.from(key, 'hex'))
    .update(fingerprint.toLowerCase())
    .digest('hex');
}

describe('a certificate-bound PIN proof', () => {
  const stored = makePinHash('1234');

  it('accepts a proof over the certificate the server is actually serving', () => {
    expect(verifyPinProof(clientProof(stored, FINGERPRINT), stored, FINGERPRINT)).toBe(true);
  });

  it('rejects a proof computed over a different certificate', () => {
    // The whole point: a man in the middle presenting its own key makes the
    // client's fingerprint differ from the server's, and it cannot produce a
    // proof over the server's without the PIN.
    expect(verifyPinProof(clientProof(stored, OTHER), stored, FINGERPRINT)).toBe(false);
  });

  it('is case-insensitive about hex, since clients differ on it', () => {
    const upper = clientProof(stored, FINGERPRINT.toUpperCase());
    expect(verifyPinProof(upper, stored, FINGERPRINT)).toBe(true);
  });

  it('rejects a proof made with the wrong PIN', () => {
    expect(verifyPinProof(clientProof(makePinHash('9999'), FINGERPRINT), stored, FINGERPRINT))
      .toBe(false);
  });

  it('rejects anything missing, malformed or empty rather than throwing', () => {
    // This runs on an unauthenticated endpoint, so every input is hostile.
    expect(verifyPinProof(undefined, stored, FINGERPRINT)).toBe(false);
    expect(verifyPinProof('', stored, FINGERPRINT)).toBe(false);
    expect(verifyPinProof('not-hex', stored, FINGERPRINT)).toBe(false);
    expect(verifyPinProof('ab', stored, FINGERPRINT)).toBe(false);          // too short
    expect(verifyPinProof(clientProof(stored, FINGERPRINT), null, FINGERPRINT)).toBe(false);
    expect(verifyPinProof(clientProof(stored, FINGERPRINT), stored, '')).toBe(false);
    expect(verifyPinProof(clientProof(stored, FINGERPRINT), 'no-colon', FINGERPRINT)).toBe(false);
  });

  it('publishes a salt a client can derive the same key from', () => {
    // Handed out unauthenticated, because a client cannot authenticate before it
    // has it. Not a secret: its job is to stop one table covering every install.
    expect(pinSalt(stored)).toBe(stored.split(':')[0]);
    expect(pinSalt(null)).toBeNull();
    expect(pinSalt('')).toBeNull();
  });
});

describe('the PIN attempt throttle', () => {
  const IP = '10.2.3.99';

  beforeEach(() => { vi.useFakeTimers(); clearPinFailures(IP); });
  afterEach(() => { vi.useRealTimers(); clearPinFailures(IP); });

  it('allows a reasonable number of mistakes', () => {
    // An operator mistyping a PIN twice must not be told to come back later.
    for (let i = 0; i < 9; i++) notePinFailure(IP);
    expect(pinRetryAfterMs(IP)).toBe(0);
  });

  it('blocks once the limit is reached', () => {
    // 10,000 candidates is a few seconds of unthrottled requests, which is the
    // cheapest way into a rig there is. The PIN length is a product decision, so
    // this is what carries it.
    for (let i = 0; i < 10; i++) notePinFailure(IP);
    expect(pinRetryAfterMs(IP)).toBeGreaterThan(0);
  });

  it('forgives after the window, so nobody is locked out for the evening', () => {
    for (let i = 0; i < 10; i++) notePinFailure(IP);
    vi.advanceTimersByTime(60_001);
    expect(pinRetryAfterMs(IP)).toBe(0);
  });

  it('clears on a correct PIN', () => {
    for (let i = 0; i < 10; i++) notePinFailure(IP);
    clearPinFailures(IP);
    expect(pinRetryAfterMs(IP)).toBe(0);
  });

  it('is per address, so one bad client cannot lock out the booth', () => {
    for (let i = 0; i < 10; i++) notePinFailure(IP);
    expect(pinRetryAfterMs('10.2.3.100')).toBe(0);
  });
});

describe('reaching the parameters at all', () => {
  // The bug this guards against was shipped: `/api/auth/pin-params` was added as
  // a route and left out of the gate's open set. A client cannot compute a proof
  // without the salt, so on exactly the installs that enable a PIN, the whole
  // certificate-bound login was unreachable - and the symptom would have been
  // "Manifold cannot log in", with nothing pointing at a gate.
  //
  // Asserted through the gate's own decision rather than by checking set
  // membership, because those are different claims: the set could be right while
  // the hook consulted something else.

  it('lets an unauthenticated client read the proof parameters', async () => {
    const { needsNoPin } = await import('../app');
    expect(needsNoPin('GET', '/api/auth/pin-params')).toBe(true);
  });

  it('lets an unauthenticated client reach status and login, as before', async () => {
    const { needsNoPin } = await import('../app');
    expect(needsNoPin('GET', '/api/auth/status')).toBe(true);
    expect(needsNoPin('POST', '/api/auth/login')).toBe(true);
  });

  it('still gates everything else', async () => {
    // The exemption must not have widened. A PIN that protects nothing is worse
    // than no PIN, because the operator believes it is doing something.
    const { needsNoPin } = await import('../app');
    expect(needsNoPin('GET', '/api/inventory')).toBe(false);
    expect(needsNoPin('PUT', '/api/auth/config')).toBe(false);
    expect(needsNoPin('POST', '/api/auth/revoke-all')).toBe(false);
    // Not a prefix match: a route merely starting with an open path is not open.
    expect(needsNoPin('GET', '/api/auth/pin-params/../inventory')).toBe(false);
    expect(needsNoPin('GET', '/api/auth/pin-paramsx')).toBe(false);
  });

  it('exempts the Micboard reads by method, not by path alone', async () => {
    // /api/live answers POST and DELETE too, and listing it as a path would have
    // let anyone on the network stand the rig down without a PIN.
    const { needsNoPin } = await import('../app');
    expect(needsNoPin('GET', '/api/live')).toBe(true);
    expect(needsNoPin('POST', '/api/live')).toBe(false);
    expect(needsNoPin('DELETE', '/api/live')).toBe(false);
  });
});
