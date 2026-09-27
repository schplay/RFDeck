import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// What RFDeck is allowed to transmit to an address that has not identified itself.
//
// DMX nodes on a venue network were locking up, and it happened when RFDeck
// restarted. The cause was this client: it opened with `Push` — the MCP
// subscription command — aimed at whatever address its inventory row named, with
// no evidence anything there was a receiver. A row whose device has moved points
// at an address somebody else now holds, and on a restart every stale row starts
// at once.
//
// The rule these pin: ask first, command only after an answer. A query costs the
// recipient one ignored datagram; a subscription asks it to start streaming.

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

const IP = '10.2.3.234';
const commands = () => sent.filter(s => s.ip === IP).map(s => s.command);
const subscriptions = () => commands().filter(c => c.startsWith('Push'));

let client: any;

beforeEach(async () => {
  sent.length = 0;
  const { G3G4Client } = await import('./G3G4Client');
  client = new G3G4Client(IP, 53212);
});

afterEach(() => {
  client?.stopPolling();
  vi.useRealTimers();
});

describe('an address that has not answered', () => {
  it('is asked, never commanded', () => {
    client.startPolling();
    // A bare `Name` is a read. Anything a lighting node receives should cost it
    // nothing more than ignoring one datagram.
    expect(commands()).toEqual(['Name']);
    expect(subscriptions()).toEqual([]);
  });

  it('is not subscribed to when it stays silent', () => {
    vi.useFakeTimers();
    client.startPolling();
    sent.length = 0;

    // Fifteen seconds of silence used to re-send `Push`, and again every fifteen
    // seconds after that, for as long as nothing answered.
    vi.advanceTimersByTime(60_000);
    expect(subscriptions()).toEqual([]);
  });

  it('is not subscribed to by the resubscribe timer either', () => {
    vi.useFakeTimers();
    client.startPolling();
    sent.length = 0;
    // The resubscribe interval must not be running at all before confirmation.
    vi.advanceTimersByTime(5 * 60_000);
    expect(subscriptions()).toEqual([]);
  });
});

describe('an address that answers MCP', () => {
  const answer = () => client.handleData('Name Vocal 1\r');

  it('is subscribed to, because now it is known to be a receiver', () => {
    client.startPolling();
    sent.length = 0;
    answer();
    expect(subscriptions().length).toBeGreaterThan(0);
  });

  it('is asked for its frequency only after it has answered', () => {
    client.startPolling();
    expect(commands()).not.toContain('Frequency');
    answer();
    expect(commands()).toContain('Frequency');
  });

  it('keeps its subscription alive once confirmed', () => {
    // Some firmware drops the subscription in RF_Mute before the window expires,
    // so a device that has answered before is re-subscribed rather than re-asked.
    vi.useFakeTimers();
    client.startPolling();
    answer();
    sent.length = 0;
    vi.advanceTimersByTime(60_000);
    expect(subscriptions().length).toBeGreaterThan(0);
  });
});

describe('an address that changes hands', () => {
  it('has to prove itself again after the client is restarted', () => {
    // Addresses get reassigned. A client stopped and started against the same
    // address must not carry forward a confirmation earned by different hardware.
    client.startPolling();
    client.handleData('Name Vocal 1\r');
    client.stopPolling();

    sent.length = 0;
    client.startPolling();
    expect(commands()).toEqual(['Name']);
    expect(subscriptions()).toEqual([]);
  });
});
