import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The whole life of a G3/G4 client, as one sequence.
//
// Every bug this file has had lived in a *transition*, not a state, and each was
// introduced by restructuring control flow without re-checking what the new shape
// did to state the old shape was maintaining:
//
//   • a backoff whose counter never advanced, because the timer driving it was
//     not re-armed;
//   • a disconnect that was never reported, because an early return was added
//     above the line that reported it;
//   • a recovery that ran once in the life of a client, because it sat inside a
//     first-time-only guard — so one hiccup degraded a receiver permanently.
//
// Testing each state in isolation found none of them. This walks the sequence a
// real receiver goes through: connect, go quiet, be reported gone, back off, come
// back, return to normal, and be reported gone again. Anything that breaks one
// transition while fixing another fails here.

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

function elapse(seconds: number, stepSeconds = 1) {
  for (let t = 0; t < seconds; t += stepSeconds) vi.advanceTimersByTime(stepSeconds * 1000);
}

const IP = '10.2.3.240';
const subscriptions = () => sent.filter(s => s.ip === IP && s.command.startsWith('Push')).length;

let client: any;
let disconnects: string[];

beforeEach(async () => {
  sent.length = 0;
  disconnects = [];
  vi.useFakeTimers();
  const { G3G4Client } = await import('./G3G4Client');
  client = new G3G4Client(IP, 53212);
  client.on('disconnected', (why: string) => disconnects.push(why));
});

afterEach(() => {
  client?.stopPolling();
  vi.useRealTimers();
});

/** A packet of the kind the periodic status stream sends. */
const packet = () => client.handleData('RF1 42\r');

describe('the full life of a receiver', () => {
  it('walks connect, loss, backoff, recovery and loss again', () => {
    const connects: number[] = [];
    client.on('connected', () => connects.push(Date.now()));

    // 1. Starts by subscribing — the only thing that makes a G3/G4 talk.
    client.startPolling();
    expect(subscriptions()).toBeGreaterThan(0);

    // 2. It answers, so it is online.
    packet();
    expect(client.isConnected).toBe(true);
    expect(connects).toHaveLength(1);

    // 3. Switched off. Within the offline window it must be reported gone —
    //    once, not repeatedly.
    elapse(40);
    expect(client.isConnected).toBe(false);
    expect(disconnects).toHaveLength(1);

    // 4. Still gone. It backs off rather than commanding the address forever,
    //    but never stops looking.
    sent.length = 0;
    elapse(5 * 60);
    const whileAway = subscriptions();
    expect(whileAway).toBeGreaterThan(0);
    expect(whileAway).toBeLessThan(30);

    // 5. Switched back on. It must return to normal service, not stay on the
    //    slow probe — this is the transition that broke every device.
    packet();
    expect(client.isConnected).toBe(true);
    expect(connects).toHaveLength(2);

    sent.length = 0;
    elapse(30);
    // Normal renewal is every 8s; the slow probe is every 30s.
    expect(subscriptions()).toBeGreaterThan(2);

    // 6. And it stays up while it keeps answering.
    disconnects.length = 0;
    for (let i = 0; i < 20; i++) { packet(); elapse(2); }
    expect(disconnects).toHaveLength(0);
    expect(client.isConnected).toBe(true);

    // 7. Switched off again. Reported again — a second outage is not swallowed
    //    by the memory of the first.
    elapse(40);
    expect(client.isConnected).toBe(false);
    expect(disconnects).toHaveLength(1);
  });

  it('does not report the same loss twice because the device answered an error', () => {
    // An MCP error reply ("1020: Value out of range [...]") proves the device is
    // reachable and carries no readings at all. Treating it as contact cleared the
    // outstanding-loss flag, so the next silent cycle reported `disconnected` a
    // second time for one outage: two dropout alerts and two cloud events for a
    // receiver that had gone off once and stayed off.
    //
    // Found by the integrations core, whose own transition test caught the same
    // bug in their MCP implementation (review item N). Worth having from both
    // sides: this is a state that only exists between two events.
    client.startPolling();
    packet();
    expect(client.isConnected).toBe(true);

    elapse(40);
    expect(disconnects).toHaveLength(1);

    // The receiver rejects something we asked for. It is there; it is not talking.
    client.handleData('1020: Value out of range [Frequency]\r');
    expect(client.isConnected).toBe(false);

    elapse(40);
    expect(disconnects).toHaveLength(1);
  });

  it('still treats an error reply as proof the device is reachable', () => {
    // The other half of the same rule. An error reply must reset the silence
    // timer — the device answered — so a receiver rejecting one command is not
    // also reported as having vanished.
    client.startPolling();
    packet();

    // OFFLINE_MS is 15 s, so each leg is well inside it and the total is not.
    elapse(10);
    client.handleData('1020: Value out of range [Frequency]\r');
    elapse(10);                        // 20 s in all, 10 s of it silent
    expect(disconnects).toHaveLength(0);
  });

  it('starts clean when the same client is restarted', () => {
    // untrack/retrack against one instance must not carry state across.
    client.startPolling();
    packet();
    elapse(40);                       // goes offline, reported
    expect(disconnects).toHaveLength(1);

    client.stopPolling();
    disconnects.length = 0;
    client.startPolling();

    elapse(40);                       // offline again on the new run
    expect(disconnects).toHaveLength(1);
  });
});
