import { describe, it, expect } from 'vitest';
import { DiscoveryService } from './DiscoveryService';

// The sweep has to cover the subnet the operator is actually on.
//
// It used to take the interface address, keep the first three octets and walk
// .1 to .254 — a /24, always, whatever the interface said its mask was. A venue
// network is routinely a /16, and on the one this was diagnosed on the hosts
// were spread across 10.2.0, 10.2.1, 10.2.2, 10.2.3, 10.2.5 and 10.2.25. A
// server on 10.2.0.x could never reach the EW-DX at 10.2.2.148, and no amount
// of scanning would have found it.
//
// It also explains why this looked like a regression that no diff could
// account for: nothing in the code changed. A DHCP lease moved one end into a
// different third octet, and EW-DX discovery stopped — while the G3s carried
// on, because MCP is a broadcast and does not care where in the subnet either
// end sits.

const addressesFor = (address: string, netmask: string): string[] =>
  (new DiscoveryService() as any).subnetAddresses({ address, netmask });

describe('the addresses a sweep covers', () => {
  it('covers a /24 completely', () => {
    const a = addressesFor('10.0.0.5', '255.255.255.0');
    expect(a).toHaveLength(254);
    expect(a[0]).toBe('10.0.0.1');
    expect(a).toContain('10.0.0.254');
  });

  it('covers the whole /16, not just the third octet it happens to sit in', () => {
    // The bug, stated as a test.
    const a = addressesFor('10.2.0.20', '255.255.0.0');
    expect(a).toContain('10.2.2.148');
    expect(a).toContain('10.2.25.53');
    expect(a.length).toBeGreaterThan(65_000);
  });

  it('sweeps its own /24 first, so the usual case resolves in seconds', () => {
    const a = addressesFor('10.2.7.20', '255.255.0.0');
    expect(a.slice(0, 254).every(ip => ip.startsWith('10.2.7.'))).toBe(true);
  });

  it('covers a /23, which a hard-coded /24 would have halved', () => {
    const a = addressesFor('192.168.4.10', '255.255.254.0');
    expect(a).toContain('192.168.4.10');
    expect(a).toContain('192.168.5.200');
  });

  it('refuses to walk something wider than a /16 and falls back to the local /24', () => {
    // 16.7m probes is not a scan, it is a week. Narrower and honest beats
    // pretending to have covered it.
    const a = addressesFor('10.1.2.3', '255.0.0.0');
    expect(a).toHaveLength(254);
    expect(a.every(ip => ip.startsWith('10.1.2.'))).toBe(true);
  });

  it('produces no duplicates', () => {
    const a = addressesFor('172.16.3.9', '255.255.0.0');
    expect(new Set(a).size).toBe(a.length);
  });
});
