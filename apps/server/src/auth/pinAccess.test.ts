import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pinRetryAfterMs, notePinFailure, clearPinFailures } from './pinAuth';

// The PIN is the whole of RFDeck's access control, and deliberately so.
//
// There are no user accounts. When an operator enables a PIN it covers every
// client from another machine - a browser, a Manifold console, anything on the
// API or the socket - with loopback always exempt and a `micboard: true`
// handshake allowed read-only. No pairing, no per-device credential, no approval:
// a console pointed at a free RFDeck with no cloud connection should just work.
//
// A certificate-bound proof form of the login was built here and removed, as was
// a plan to gate the UI alone and leave the API open. Both were rejected as
// product decisions rather than oversights, so the tests below cover the PIN as
// it is rather than as either of those would have had it.

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
    // Four digits is 10,000 candidates, which is seconds of unthrottled requests
    // rather than a cryptographic attack. PIN length is a product decision - speed
    // and ease of use come first - so this is what carries that decision.
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

describe('what the PIN gate lets through unauthenticated', () => {
  // Asserted through the gate's own decision rather than by checking the contents
  // of its open-path set, because those are different claims: the set could be
  // right while the hook consulted something else. That distinction is not
  // academic - a route was once added and left out of the set, which made the
  // feature that needed it unreachable on exactly the installs that enable a PIN.

  it('allows the two calls a client needs before it can authenticate', async () => {
    const { needsNoPin } = await import('../app');
    // Status is how a client discovers it needs a PIN at all, and now also carries
    // the certificate fingerprint for the operator to compare when pairing.
    expect(needsNoPin('GET', '/api/auth/status')).toBe(true);
    expect(needsNoPin('POST', '/api/auth/login')).toBe(true);
  });

  it('gates everything else, including by exact path rather than prefix', async () => {
    // A PIN that protects nothing is worse than no PIN, because the operator
    // believes it is doing something.
    const { needsNoPin } = await import('../app');
    expect(needsNoPin('GET', '/api/inventory')).toBe(false);
    expect(needsNoPin('PUT', '/api/auth/config')).toBe(false);
    expect(needsNoPin('POST', '/api/auth/revoke-all')).toBe(false);
    expect(needsNoPin('GET', '/api/auth/statusx')).toBe(false);
    expect(needsNoPin('GET', '/api/auth/status/../inventory')).toBe(false);
  });

  it('no longer exposes the withdrawn proof parameters', async () => {
    // Removed with the proof mechanism. Named here so that re-adding the route
    // without reconsidering the premise trips a test rather than shipping.
    const { needsNoPin } = await import('../app');
    expect(needsNoPin('GET', '/api/auth/pin-params')).toBe(false);
  });

  it('exempts the Micboard reads by method, not by path alone', async () => {
    // /api/live answers POST and DELETE too, and listing it as a path would let
    // anyone on the network stand the whole rig down without a PIN.
    const { needsNoPin } = await import('../app');
    expect(needsNoPin('GET', '/api/live')).toBe(true);
    expect(needsNoPin('POST', '/api/live')).toBe(false);
    expect(needsNoPin('DELETE', '/api/live')).toBe(false);
  });
});
