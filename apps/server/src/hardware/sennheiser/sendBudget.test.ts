import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The last line of defence against RFDeck degrading somebody's network.
//
// Every other fix addresses a reason the bus was over-used. This one exists because
// nothing downstream of `sendTo` was ever bounded, so a mistake in choosing targets
// became a network outage — a sweep sized to the netmask instead of to the rig put
// 25,600 packets a second onto a venue's network, in bursts, for as long as any one
// device was switched off, and the only way to stop it was to kill the process.
//
// The ceiling is far above correct operation: subscription renewal for a large rig
// is single digits per second and a bounded sweep is about 1,300. So this can only
// be reached by a bug, which is why tripping it logs at `error`.

describe('the outbound MCP ceiling', () => {
  let bus: any;
  let sent: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    const { McpBus } = await import('./McpBus');
    bus = new (McpBus as any)();
    sent = 0;
    // Stand in for a bound socket, counting what actually reaches the wire.
    bus.ready = true;
    bus.sock = { send: () => { sent++; } };
  });

  afterEach(() => { vi.useRealTimers(); });

  it('lets ordinary traffic through untouched', () => {
    // A large rig renewing subscriptions is nowhere near the ceiling.
    for (let i = 0; i < 500; i++) bus.sendTo('10.2.3.10', 'Push 8 500 3');
    expect(sent).toBe(500);
  });

  it('stops a runaway sender before it reaches the network', () => {
    for (let i = 0; i < 50_000; i++) bus.sendTo('10.2.3.10', 'Name');
    // Whatever the caller asked for, the wire sees the ceiling and no more.
    expect(sent).toBe(4_000);
  });

  it('recovers on the next second rather than staying shut', () => {
    for (let i = 0; i < 50_000; i++) bus.sendTo('10.2.3.10', 'Name');
    expect(sent).toBe(4_000);

    vi.advanceTimersByTime(1_000);
    bus.sendTo('10.2.3.10', 'Name');
    expect(sent).toBe(4_001);
  });

  it('holds across every address, not per address', () => {
    // The flood was one datagram each to tens of thousands of addresses, so a
    // per-address limit would not have caught any of it.
    for (let i = 0; i < 20_000; i++) bus.sendTo(`10.2.${(i >> 8) & 255}.${i & 255}`, 'Name');
    expect(sent).toBe(4_000);
  });
});
