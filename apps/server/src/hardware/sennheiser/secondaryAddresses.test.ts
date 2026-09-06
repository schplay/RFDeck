import { describe, it, expect } from 'vitest';
import { secondaryAddresses } from './DeviceManagerService';

// Hiding an address from discovery is destructive and must be earned.
//
// An EW-DX has two interfaces sharing one identity, so its Dante address has
// to be suppressed or it is offered as a second device. But a suppressed
// address cannot be added, and nothing on screen explains its absence — so the
// decision may only be made on what the device actually labelled as an
// address, never on a string that merely looks like one.

const net = (over: Partial<{ controlAll: string[]; danteAddrs: string[] }> = {}) => ({
  controlAll: [],
  danteAddrs: [],
  ...over,
});

describe('which addresses count as a secondary interface', () => {
  it('takes the ones the device labelled as Dante addresses', () => {
    const out = secondaryAddresses(net({ danteAddrs: ['10.0.1.20'] }), '10.0.0.5');
    expect(out).toEqual(['10.0.1.20']);
  });

  it('never suppresses the address RFDeck is connected on', () => {
    const out = secondaryAddresses(net({ danteAddrs: ['10.0.0.5'] }), '10.0.0.5');
    expect(out).toEqual([]);
  });

  it('never suppresses a control address', () => {
    // In switched mode both logical interfaces can report the same address.
    // Suppressing it would hide the device from its own discovery.
    const out = secondaryAddresses(
      net({ controlAll: ['10.0.0.5', '10.0.0.6'], danteAddrs: ['10.0.0.6'] }),
      '10.0.0.5',
    );
    expect(out).toEqual([]);
  });

  it('ignores netmasks, loopback and unconfigured addresses', () => {
    const out = secondaryAddresses(
      net({ danteAddrs: ['255.255.255.0', '127.0.0.1', '0.0.0.0', '10.0.1.20'] }),
      '10.0.0.5',
    );
    expect(out).toEqual(['10.0.1.20']);
  });

  it('suppresses nothing when the device names no addresses', () => {
    // The regression this replaces: with no properly-keyed addresses the code
    // fell back to every IPv4 anywhere in the payload, so a receiver's gateway
    // and DNS server were registered as its own interfaces and any real device
    // at those addresses vanished from discovery. Finding one spurious entry
    // in a list beats a device that cannot be found and gives no reason.
    const out = secondaryAddresses(net({ danteAddrs: [] }), '10.0.0.5');
    expect(out).toEqual([]);
  });
});
