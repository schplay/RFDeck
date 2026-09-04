import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'dgram';
import os from 'os';
import {
  ShureSlpListener, SHURE_SLP_GROUP, SHURE_SLP_PORT, SlpAnnouncement,
} from './slp';

// The listener socket itself, not just the parsing.
//
// This is one of the few parts of Shure support that CAN be verified without a
// receiver: binding the port, joining the multicast group and receiving a
// datagram are all local operations. A packet is sent to the group and, for
// machines where multicast loopback is unavailable, to the port directly —
// either way the listener has to bind, receive, parse and emit.
//
// Verified additionally by hand on Windows 11 with a real multicast send: the
// listener joined 239.255.254.253 on the physical interface and received it.

const started: ShureSlpListener[] = [];
const sockets: dgram.Socket[] = [];

afterEach(() => {
  for (const l of started.splice(0)) l.stop();
  for (const s of sockets.splice(0)) { try { s.close(); } catch { /* already closed */ } }
});

function localIpv4(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

function listen(): { listener: ShureSlpListener; announcements: SlpAnnouncement[] } {
  const listener = new ShureSlpListener();
  started.push(listener);
  const announcements: SlpAnnouncement[] = [];
  listener.on('announce', a => announcements.push(a));
  listener.start(localIpv4());
  return { listener, announcements };
}

async function send(payload: string): Promise<void> {
  const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sockets.push(tx);
  await new Promise<void>(r => tx.bind(0, () => r()));
  try {
    tx.setMulticastTTL(1);
    tx.setMulticastLoopback(true);
    await new Promise<void>(r => tx.send(payload, SHURE_SLP_PORT, SHURE_SLP_GROUP, () => r()));
  } catch { /* no multicast here; the unicast below still exercises the path */ }
  await new Promise<void>(r => tx.send(payload, SHURE_SLP_PORT, '127.0.0.1', () => r()));
}

async function settle(ms = 400): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

describe('ShureSlpListener', () => {
  it('binds, receives an announcement, and reports where it came from', async () => {
    const { announcements } = listen();
    await settle(200);

    await send('(cd:0x0A1B2C3D),(model:AD4D)');
    await settle();

    expect(announcements.length).toBeGreaterThan(0);
    // The source address is the useful part — the model is asked for later,
    // over 2202, because the class id needs a map RFDeck does not have.
    expect(announcements[0].ip).toBeTruthy();
    expect(announcements[0].dcid).toBe('0x0A1B2C3D');
  });

  it('ignores traffic on the port that is not an announcement', async () => {
    // The port is shared with whatever else on the network uses SLP. A stray
    // datagram must not become a candidate device and trigger a probe.
    const { announcements } = listen();
    await settle(200);

    await send('some other service entirely');
    await settle();

    expect(announcements).toHaveLength(0);
  });

  it('reports an announcement with no class id rather than dropping it', async () => {
    // Being strict here would silently lose models whose announcement differs
    // from the one example available; the probe is what actually decides.
    const { announcements } = listen();
    await settle(200);

    await send('(shure:something),(other:1)');
    await settle();

    expect(announcements.length).toBeGreaterThan(0);
    expect(announcements[0].dcid).toBeNull();
  });

  it('stops cleanly, and stopping twice is not an error', async () => {
    const { listener } = listen();
    await settle(150);
    listener.stop();
    expect(() => listener.stop()).not.toThrow();
  });

  it('survives a second listener on the same port', async () => {
    // reuseAddr, so another Shure tool on this machine — or a second RFDeck
    // during a restart — does not stop discovery working. Without it the bind
    // fails and Shure devices silently never appear.
    const first = listen();
    await settle(150);
    const second = listen();
    await settle(150);

    await send('(cd:0xFEED)');
    await settle();

    expect(first.announcements.length + second.announcements.length).toBeGreaterThan(0);
  });
});
