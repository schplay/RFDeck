import { describe, it, expect } from 'vitest';
import { macFromLookupOutput, isDirectlyAttached } from './arp';

// Two questions about a hardware address that RFDeck used to conflate: what the
// neighbour table said, and whether it could ever have anything to say.

describe('reading a MAC out of a lookup', () => {
  it('reads every platform format and normalises it', () => {
    const want = 'a4:c3:f0:dd:72:38';
    expect(macFromLookupOutput('  10.2.1.154    a4-c3-f0-dd-72-38    dynamic')).toBe(want);
    expect(macFromLookupOutput('10.2.1.154 dev eno1 lladdr a4:c3:f0:dd:72:38 REACHABLE')).toBe(want);
    expect(macFromLookupOutput('10.2.1.154 ether a4:c3:f0:dd:72:38 C eth0')).toBe(want);
    expect(macFromLookupOutput('10.2.1.154 (10.2.1.154) at a4:c3:f0:dd:72:38 on en0')).toBe(want);
  });

  it('treats an unresolved entry as a miss', () => {
    // A FAILED or INCOMPLETE entry prints no address, and reporting one anyway
    // would put a wrong identity on an inventory row.
    expect(macFromLookupOutput('10.2.1.154 dev eno1  FAILED')).toBeNull();
    expect(macFromLookupOutput('10.2.1.154 dev eno1 lladdr  INCOMPLETE')).toBeNull();
    expect(macFromLookupOutput('')).toBeNull();
  });
});

describe('whether a hardware address is obtainable at all', () => {
  const ifaces = [
    { address: '10.2.3.10', netmask: '255.255.255.0' },
    { address: '192.168.1.5', netmask: '255.255.255.0' },
  ];

  it('is true on an attached subnet', () => {
    expect(isDirectlyAttached('10.2.3.234', ifaces)).toBe(true);
    expect(isDirectlyAttached('192.168.1.99', ifaces)).toBe(true);
  });

  it('is false across a router, which is the case that cannot be waited out', () => {
    // The rig this was found on: server on 10.2.3.x, receivers on 10.2.5.x. No
    // neighbour entry for those exists or ever will, so "keep retrying" is wrong
    // and "correct it by hand" is the only honest advice.
    expect(isDirectlyAttached('10.2.5.6', ifaces)).toBe(false);
  });

  it('respects the mask rather than assuming a /24', () => {
    const wide = [{ address: '10.2.3.10', netmask: '255.255.0.0' }];
    expect(isDirectlyAttached('10.2.5.6', wide)).toBe(true);
    expect(isDirectlyAttached('10.3.5.6', wide)).toBe(false);
  });

  it('compares unsigned, so a high first octet still matches', () => {
    // The bug this guards: a mask of 255.255.255.0 is negative as a signed 32-bit
    // integer, and an address like 172.x or 192.x is too. Without the >>> 0 the
    // comparison silently disagrees for exactly the ranges most rigs use.
    const high = [{ address: '172.16.4.10', netmask: '255.255.255.0' }];
    expect(isDirectlyAttached('172.16.4.200', high)).toBe(true);
    expect(isDirectlyAttached('172.16.5.200', high)).toBe(false);
  });

  it('is false when there are no interfaces, or the address is not an address', () => {
    expect(isDirectlyAttached('10.2.3.4', [])).toBe(false);
    expect(isDirectlyAttached('not-an-ip', ifaces)).toBe(false);
    expect(isDirectlyAttached('10.2.3.999', ifaces)).toBe(false);
  });
});
