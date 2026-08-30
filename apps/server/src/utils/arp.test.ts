import { describe, it, expect } from 'vitest';
import { macFromLookupOutput } from './arp';

// The MAC lookup is the hinge of automatic reconnection after a DHCP change.
// It silently returned null on every headless server for months because it
// shelled out to `arp`, which Ubuntu no longer installs — so pin the parse
// against the real output of every tool it now uses.

describe('macFromLookupOutput', () => {
  it('parses `ip neigh` (the Linux default)', () => {
    expect(macFromLookupOutput('10.2.1.154 dev eno1 lladdr a4:c3:f0:dd:72:38 REACHABLE'))
      .toBe('a4:c3:f0:dd:72:38');
    expect(macFromLookupOutput('10.2.1.154 dev eno1 lladdr A4:C3:F0:DD:72:38 STALE'))
      .toBe('a4:c3:f0:dd:72:38');
  });

  it('returns null for a FAILED neighbour entry, which has no address', () => {
    expect(macFromLookupOutput('10.2.1.154 dev eno1 FAILED')).toBeNull();
    expect(macFromLookupOutput('10.2.1.154 dev eno1 INCOMPLETE')).toBeNull();
  });

  it('parses Windows arp output and normalises the dashes', () => {
    expect(macFromLookupOutput('  10.2.1.154    a4-c3-f0-dd-72-38    dynamic'))
      .toBe('a4:c3:f0:dd:72:38');
  });

  it('parses net-tools and macOS arp output', () => {
    expect(macFromLookupOutput('10.2.1.154 ether a4:c3:f0:dd:72:38 C eth0'))
      .toBe('a4:c3:f0:dd:72:38');
    expect(macFromLookupOutput('10.2.1.154 (10.2.1.154) at a4:c3:f0:dd:72:38 on en0'))
      .toBe('a4:c3:f0:dd:72:38');
  });

  it('returns null for empty or error output', () => {
    expect(macFromLookupOutput('')).toBeNull();
    expect(macFromLookupOutput('10.2.1.154 -- no entry')).toBeNull();
  });
});
