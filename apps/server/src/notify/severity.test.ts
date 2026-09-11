import { describe, it, expect } from 'vitest';
import { passesThreshold, normaliseThreshold } from './severity';

// The one rule every notification channel shares: is this loud enough to send.

describe('passesThreshold', () => {
  it('sends anything at or above the threshold', () => {
    expect(passesThreshold('CRITICAL', 'CRITICAL')).toBe(true);
    expect(passesThreshold('CRITICAL', 'WARNING')).toBe(true);
    expect(passesThreshold('WARNING', 'WARNING')).toBe(true);
    expect(passesThreshold('INFO', 'INFO')).toBe(true);
  });

  it('holds back anything below it', () => {
    // The default. A mute is a WARNING; a webhook that fired on every mute
    // would be switched off within a night.
    expect(passesThreshold('WARNING', 'CRITICAL')).toBe(false);
    expect(passesThreshold('INFO', 'WARNING')).toBe(false);
  });

  it('treats an unknown severity as the quietest, and an unknown threshold as the loudest', () => {
    // Failing quiet on both sides: an alert with a malformed severity does
    // not page anyone, and a target with a malformed threshold does not get
    // everything.
    expect(passesThreshold('BOGUS', 'INFO')).toBe(true);
    expect(passesThreshold('BOGUS', 'WARNING')).toBe(false);
    expect(passesThreshold('WARNING', 'BOGUS')).toBe(false);
    expect(passesThreshold('CRITICAL', undefined)).toBe(true);
  });
});

describe('normaliseThreshold', () => {
  it('keeps a valid value and defaults the rest to CRITICAL', () => {
    expect(normaliseThreshold('INFO')).toBe('INFO');
    expect(normaliseThreshold('warning')).toBe('CRITICAL');
    expect(normaliseThreshold(null)).toBe('CRITICAL');
  });
});
