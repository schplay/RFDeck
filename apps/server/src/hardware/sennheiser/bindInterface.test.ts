import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import { mcpBus } from './McpBus';

// The interface chosen in Settings has to actually be used.
//
// Settings has offered this choice for as long as there has been a Settings
// page, described there as "used for mDNS discovery and hardware
// communication". Nothing read it. The value was stored, redisplayed and
// ignored, and every interface was used regardless — so an operator with a
// control network and a Dante network could not tell RFDeck which one the rack
// was on, and discovery saw every EW-DX twice, once per NIC, with the same
// serial on both.

const IFACES: any = {
  eth0: [
    { family: 'IPv4', internal: false, address: '10.0.0.10', netmask: '255.255.255.0' },
  ],
  dante: [
    { family: 'IPv4', internal: false, address: '10.1.0.10', netmask: '255.255.255.0' },
  ],
  lo: [
    { family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' },
  ],
  wifi: [
    { family: 'IPv4', internal: false, address: '169.254.3.4', netmask: '255.255.0.0' },
  ],
};

beforeEach(() => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(IFACES);
  mcpBus.setBindAddress('0.0.0.0');
});

afterEach(() => {
  vi.restoreAllMocks();
  mcpBus.setBindAddress('0.0.0.0');
});

const addresses = () => mcpBus.getActiveInterfaces().map(i => i.address);

describe('the network interface setting', () => {
  it('uses every interface when set to 0.0.0.0', () => {
    expect(addresses()).toEqual(['10.0.0.10', '10.1.0.10']);
  });

  it('uses only the chosen one', () => {
    mcpBus.setBindAddress('10.0.0.10');
    expect(addresses()).toEqual(['10.0.0.10']);
  });

  it('keeps the Dante network out of discovery when control is chosen', () => {
    // The case this exists for: one receiver answering on two NICs with the
    // same serial is what makes discovery guess which address is real.
    mcpBus.setBindAddress('10.0.0.10');
    expect(addresses()).not.toContain('10.1.0.10');
  });

  it('narrows the broadcast probes to the chosen interface', () => {
    mcpBus.setBindAddress('10.1.0.10');
    const casts = mcpBus.getBroadcastAddresses();
    expect(casts).toContain('10.1.0.255');
    expect(casts).not.toContain('10.0.0.255');
  });

  it('never leaves RFDeck deaf when the saved interface is gone', () => {
    // A NIC replaced, a lease changed, a config copied between servers. Losing
    // the ability to find any hardware would be far worse than ignoring a
    // setting that no longer describes anything — so it falls back to all of
    // them, and says so.
    mcpBus.setBindAddress('192.168.99.99');
    expect(addresses()).toEqual(['10.0.0.10', '10.1.0.10']);
  });

  it('treats an empty or missing value as all interfaces', () => {
    mcpBus.setBindAddress('');
    expect(addresses()).toEqual(['10.0.0.10', '10.1.0.10']);
    mcpBus.setBindAddress(null);
    expect(addresses()).toEqual(['10.0.0.10', '10.1.0.10']);
    mcpBus.setBindAddress(undefined);
    expect(addresses()).toEqual(['10.0.0.10', '10.1.0.10']);
  });

  it('still ignores loopback and link-local addresses', () => {
    expect(addresses()).not.toContain('127.0.0.1');
    expect(addresses()).not.toContain('169.254.3.4');
  });
});
