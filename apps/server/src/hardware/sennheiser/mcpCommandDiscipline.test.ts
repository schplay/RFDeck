import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// How long RFDeck keeps commanding an address that never answers.
//
// DMX nodes on a venue network were locking up, and it tracked RFDeck restarts.
// The cause was this client: an inventory row whose device has moved points at an
// address somebody else now holds, and this re-sent `Push` — the MCP subscription
// command — to it every fifteen seconds, forever, starting again on every restart.
// A restart starts every stale row's client at once.
//
// The first attempt at a fix removed the subscription and opened with a bare
// `Name` instead. That broke every G3 and G4: `Push` is what makes them talk, so
// they went silent, undiscovered and unconnectable. The protocol offers no politer
// way to ask.
//
// So the subscription stays and the *endlessness* goes. These pin that: a few
// attempts at the fast rate, then minutes apart, and never abandoned — while a
// device that has answered keeps the renewal its firmware needs.

const sent: Array<{ ip: string; command: string }> = [];

vi.mock('./McpBus', () => ({
  mcpBus: {
    addHandler: vi.fn(),
    removeHandler: vi.fn(),
    sendTo: (ip: string, command: string) => { sent.push({ ip, command }); },
    sendToMany: (ips: string[], command: string) => {
      for (const ip of ips) sent.push({ ip, command });
    },
  },
}));

/**
 * Advance in steps rather than one jump.
 *
 * A single large `advanceTimersByTime` runs a repeating interval to completion
 * against nested timeouts in an order real time never produces, which made a
 * working backoff look like it was not engaging at all. Stepping matches how the
 * clock actually moves.
 */
function elapse(seconds: number, stepSeconds = 5) {
  for (let t = 0; t < seconds; t += stepSeconds) vi.advanceTimersByTime(stepSeconds * 1000);
}

const IP = '10.2.3.234';
const commands = () => sent.filter(s => s.ip === IP).map(s => s.command);
const subscriptions = () => commands().filter(c => c.startsWith('Push'));

let client: any;

beforeEach(async () => {
  sent.length = 0;
  vi.useFakeTimers();
  const { G3G4Client } = await import('./G3G4Client');
  client = new G3G4Client(IP, 53212);
});

afterEach(() => {
  client?.stopPolling();
  vi.useRealTimers();
});

describe('reaching a device at all', () => {
  it('subscribes on start, because that is what makes a G3/G4 answer', () => {
    client.startPolling();
    // Removing this is what left every G3 and G4 silent.
    expect(subscriptions().length).toBeGreaterThan(0);
    expect(commands()).toContain('Name');
  });
});

describe('a receiver that goes quiet', () => {
  it('is reported as disconnected, which is the whole point of watching it', () => {
    // This regressed: `handleOffline` returned early for a device that had
    // connected before, so a receiver that was switched off was never reported
    // gone. The dashboard kept showing it online and no alert fired. A monitor
    // that keeps claiming a dead receiver is live is worse than a slow one.
    client.startPolling();
    client.handleData('Name Vocal 1\r');   // it is alive
    const seen: string[] = [];
    client.on('disconnected', (why: string) => seen.push(why));

    elapse(60);                            // power it off
    expect(seen.length).toBeGreaterThan(0);
  });

  it('reports it once, not on every retry', () => {
    client.startPolling();
    client.handleData('Name Vocal 1\r');
    const seen: string[] = [];
    client.on('disconnected', (why: string) => seen.push(why));

    elapse(10 * 60);
    expect(seen).toHaveLength(1);
  });

  it('reports an address that never answered at all', () => {
    // A device that has never been reachable still has to be shown as offline.
    client.startPolling();
    const seen: string[] = [];
    client.on('disconnected', (why: string) => seen.push(why));

    elapse(60);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('an address that never answers', () => {
  it('is not commanded every fifteen seconds indefinitely', () => {
    client.startPolling();
    sent.length = 0;

    // Ten minutes of silence. The old behaviour was a subscription every eight
    // seconds forever — about seventy-five of them aimed at a lighting node.
    //
    // The bound is not as low as it could be, deliberately. This client only ever
    // talks to the one address an operator put in the inventory, so the cost to a
    // host that is not a receiver is two datagrams every thirty seconds, while the
    // benefit is that a receiver switched back on at its own address is found in
    // half a minute rather than five. The lock-ups came from the discovery sweep
    // commanding tens of thousands of addresses, which is a different thing and is
    // bounded elsewhere.
    elapse(10 * 60);
    expect(subscriptions().length).toBeLessThan(40);
  });

  it('is still tried occasionally, so a receiver switched off comes back on its own', () => {
    client.startPolling();
    sent.length = 0;

    // Backed off is not abandoned: a rig off for the weekend must return without
    // anybody pressing anything.
    elapse(30 * 60);
    expect(subscriptions().length).toBeGreaterThan(0);
  });

  it('slows down rather than stopping dead after its first few attempts', () => {
    client.startPolling();
    sent.length = 0;

    elapse(2 * 60);
    const early = subscriptions().length;
    elapse(2 * 60);
    const later = subscriptions().length - early;

    // The rate must fall sharply, not merely not rise.
    expect(early).toBeGreaterThan(0);
    expect(later).toBeLessThan(early);
  });
});

describe('an address that answers', () => {
  const answer = () => client.handleData('Name Vocal 1\r');

  it('keeps its subscription renewed, which firmware in RF_Mute needs', () => {
    client.startPolling();
    answer();
    sent.length = 0;
    elapse(5 * 60);
    expect(subscriptions().length).toBeGreaterThan(0);
  });

  it('is not left on the slow rate it may have fallen back to', () => {
    // A receiver that was switched off, backed off, and then powered on again has
    // to return to normal service rather than stay on a five-minute probe.
    client.startPolling();
    elapse(10 * 60);   // fall back
    answer();          // it comes back
    sent.length = 0;

    elapse(90);
    expect(subscriptions().length).toBeGreaterThan(0);
  });
});

describe('a client restarted against the same address', () => {
  it('starts over rather than carrying forward what it learned', () => {
    // Addresses change hands.
    client.startPolling();
    client.handleData('Name Vocal 1\r');
    client.stopPolling();

    sent.length = 0;
    client.startPolling();
    expect(subscriptions().length).toBeGreaterThan(0);
  });
});
