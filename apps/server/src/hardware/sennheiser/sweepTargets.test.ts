import { describe, it, expect, vi, beforeEach } from 'vitest';

// Which addresses a scan actually covers.
//
// The sweep walked the subnets of the server's own network interfaces and nothing
// else. That is only the same thing as "where the receivers are" when every
// receiver shares a subnet with the server. A rig on its own VLAN, or one device
// that moved across one, was never probed — no discovery, no log line, nothing to
// explain it, and the only way back was retyping an address by hand.
//
// The inventory is the other half of the picture: a row records where its device
// last answered, and that stays true about the network long after DHCP has changed
// the host part. These pin that both halves are searched.

const ifaces: Array<{ address: string; netmask: string }> = [];

vi.mock('./McpBus', () => ({
  mcpBus: {
    getActiveInterfaces: () => ifaces,
    getBroadcastAddresses: () => [],
    addHandler: vi.fn(), removeHandler: vi.fn(),
    addAnyHandler: vi.fn(), removeAnyHandler: vi.fn(),
    sendTo: vi.fn(), sendToMany: vi.fn(),
  },
}));

let service: any;

beforeEach(async () => {
  ifaces.length = 0;
  const { DiscoveryService } = await import('./DiscoveryService');
  service = new DiscoveryService(true); // disabled: nothing is transmitted here
});

/** The address lists a scan would cover, flattened. */
const targets = (): string[] =>
  service.sweepTargets().flatMap((t: { addresses: string[] }) => t.addresses);

describe('the server’s own subnets', () => {
  it('are swept', () => {
    ifaces.push({ address: '10.2.3.10', netmask: '255.255.255.0' });
    const all = targets();
    expect(all).toContain('10.2.3.1');
    expect(all).toContain('10.2.3.254');
  });
});

describe('subnets where devices were last seen', () => {
  it('are swept even though no interface is on them', () => {
    // The case that left an EW-DX unreachable: server on one VLAN, receiver on
    // another, and nothing ever looked at the receiver's.
    ifaces.push({ address: '10.2.3.10', netmask: '255.255.255.0' });
    service.setSearchHints(['10.2.0.4']);

    const all = targets();
    expect(all).toContain('10.2.0.4');
    expect(all).toContain('10.2.0.1');
    // And the interface subnet is still covered.
    expect(all).toContain('10.2.3.1');
  });

  it('cover the whole /24 around a device, not just its last address', () => {
    // The host part is exactly what DHCP changed; the network part is the clue.
    ifaces.push({ address: '10.2.3.10', netmask: '255.255.255.0' });
    service.setSearchHints(['10.2.0.4']);

    const all = targets();
    expect(all).toContain('10.2.0.77');
    expect(all).toContain('10.2.0.254');
  });

  it('are not swept twice when an interface already reaches them', () => {
    ifaces.push({ address: '10.2.3.10', netmask: '255.255.255.0' });
    service.setSearchHints(['10.2.3.234']);

    const all = targets();
    expect(all.filter(a => a === '10.2.3.234')).toHaveLength(1);
  });

  it('collapse several devices on one subnet into a single range', () => {
    ifaces.push({ address: '10.2.3.10', netmask: '255.255.255.0' });
    service.setSearchHints(['10.9.0.4', '10.9.0.5', '10.9.0.200']);

    const all = targets();
    expect(all.filter(a => a === '10.9.0.4')).toHaveLength(1);
    expect(all).toContain('10.9.0.200');
  });

  it('ignore anything that is not an address', () => {
    ifaces.push({ address: '10.2.3.10', netmask: '255.255.255.0' });
    service.setSearchHints(['', 'not-an-ip', 'example.local']);
    expect(() => targets()).not.toThrow();
  });
});

describe('a flat /16, which is a perfectly ordinary show network', () => {
  it('is swept in full rather than reduced to the local /24', () => {
    ifaces.push({ address: '10.2.3.10', netmask: '255.255.0.0' });
    const all = targets();
    // Both ends, and an address in a different third octet from the server's.
    expect(all).toContain('10.2.0.1');
    expect(all).toContain('10.2.3.234');
    expect(all).toContain('10.2.255.254');
    expect(all.length).toBeGreaterThan(65_000);
  });

  it('gets a guard long enough to finish, so nothing is cut off unprobed', async () => {
    // A fixed guard was an unstated assumption about network size: exceed it and
    // every address past the cut is silently never probed, which looks exactly
    // like a receiver that cannot be found.
    const { scanGuardMs } = await import('./DiscoveryService');
    ifaces.push({ address: '10.2.3.10', netmask: '255.255.0.0' });
    const total = targets().length;

    // A /16 measured at about 51 seconds on real hardware. The guard has to sit
    // well above that, and above the worst case where every address is a silent
    // host paying the full connect timeout.
    expect(scanGuardMs(total)).toBeGreaterThan(120_000);
  });

  it('never guards a sweep for less than the floor, however small', async () => {
    const { scanGuardMs } = await import('./DiscoveryService');
    expect(scanGuardMs(0)).toBeGreaterThanOrEqual(180_000);
    expect(scanGuardMs(254)).toBeGreaterThanOrEqual(180_000);
  });

  it('grows with the network rather than assuming one', async () => {
    // The property that makes this safe on a size nobody predicted.
    const { scanGuardMs } = await import('./DiscoveryService');
    expect(scanGuardMs(1_000_000)).toBeGreaterThan(scanGuardMs(65_534));
  });
});

describe('with no interfaces at all', () => {
  it('still searches where the devices were', () => {
    // A server whose interface enumeration comes back empty should not silently
    // stop looking for hardware it knows about.
    service.setSearchHints(['10.2.0.4']);
    expect(targets()).toContain('10.2.0.4');
  });
});
