import { describe, it, expect, beforeEach } from 'vitest';
import {
  makePinHash, verifyPin, isLoopback,
  issueToken, isTokenValid, revokeAllTokens,
} from './pinAuth';

beforeEach(() => revokeAllTokens());

describe('PIN hashing', () => {
  it('accepts the correct PIN', () => {
    const stored = makePinHash('4821');
    expect(verifyPin('4821', stored)).toBe(true);
  });

  it('rejects an incorrect PIN', () => {
    const stored = makePinHash('4821');
    expect(verifyPin('4822', stored)).toBe(false);
    expect(verifyPin('', stored)).toBe(false);
    expect(verifyPin('48210', stored)).toBe(false);
  });

  it('salts, so the same PIN hashes differently each time', () => {
    // Without a per-record salt, identical PINs across installs would produce
    // identical hashes and be trivially recognisable.
    expect(makePinHash('1234')).not.toBe(makePinHash('1234'));
  });

  it('rejects a malformed stored value instead of throwing', () => {
    expect(verifyPin('1234', 'garbage')).toBe(false);
    expect(verifyPin('1234', '')).toBe(false);
  });
});

describe('loopback detection', () => {
  it('recognises local addresses', () => {
    // The host machine is always trusted — the desktop window must never be
    // locked out of its own server.
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    // Node reports IPv4 over IPv6 sockets in this form.
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('treats LAN addresses as remote', () => {
    expect(isLoopback('10.2.1.50')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe('tokens', () => {
  it('accepts a freshly issued token', () => {
    const token = issueToken(0);
    expect(isTokenValid(token)).toBe(true);
  });

  it('rejects an unknown token', () => {
    expect(isTokenValid('never-issued')).toBe(false);
    expect(isTokenValid(undefined)).toBe(false);
  });

  it('never expires when reauthHours is 0', () => {
    // A resident booth display should not be prompted again.
    const token = issueToken(0);
    expect(isTokenValid(token)).toBe(true);
  });

  it('issues unique tokens', () => {
    expect(issueToken(0)).not.toBe(issueToken(0));
  });

  it('invalidates every token on revoke', () => {
    // Used when the PIN is rotated or on a crew change.
    const a = issueToken(0);
    const b = issueToken(24);
    revokeAllTokens();
    expect(isTokenValid(a)).toBe(false);
    expect(isTokenValid(b)).toBe(false);
  });
});
