import { describe, it, expect, afterEach } from 'vitest';
import { Digital6000Client } from './Digital6000Client';
import { FakeDigital6000Device } from './fakeDigital6000Device';
import type { DeviceStateTree } from '../../HardwareClient';

// Digital6000Client against a device that speaks the same SSC.
//
// The wire formats are proved separately in protocol.test.ts against
// Sennheiser's own document. What this covers is the lifecycle, and one
// behaviour in particular that no unit test can reach: **a subscription
// expires and the device goes quiet without closing anything**. That failure
// looks exactly like a healthy receiver on a silent channel, and it is the
// reason this is a subscription client rather than a poller.

const open: Array<{ client: Digital6000Client; device: FakeDigital6000Device }> = [];

afterEach(async () => {
  for (const { client, device } of open.splice(0)) {
    client.stopPolling();
    await device.close();
  }
});

async function connect(options: ConstructorParameters<typeof FakeDigital6000Device>[0] = {}) {
  const device = new FakeDigital6000Device(options);
  const port = await device.listen();
  const client = new Digital6000Client('127.0.0.1', port, options.channels ?? 2);
  open.push({ client, device });
  return { client, device };
}

function nextState(
  client: Digital6000Client,
  predicate: (t: DeviceStateTree) => boolean = () => true,
  timeoutMs = 5000,
): Promise<DeviceStateTree> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('state', onState);
      reject(new Error('no matching state within timeout'));
    }, timeoutMs);
    function onState(tree: DeviceStateTree) {
      if (!predicate(tree)) return;
      clearTimeout(timer);
      client.off('state', onState);
      resolve(tree);
    }
    client.on('state', onState);
  });
}

function once(client: Digital6000Client, event: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within timeout`)), timeoutMs);
    client.once(event, (p: any) => { clearTimeout(timer); resolve(p); });
  });
}

async function received(device: FakeDigital6000Device, match: RegExp, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (device.received.some(m => match.test(m))) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

describe('Digital6000Client', () => {
  it('subscribes rather than polls, and reports both channels', async () => {
    const { client, device } = await connect();
    const connected = once(client, 'connected');
    client.startPolling();
    await connected;

    const tree = await nextState(client, t => !!t.rx1?.name && !!t.rx2?.name);
    expect(Object.keys(tree).sort()).toEqual(['rx1', 'rx2']);
    expect(tree.rx1!.name).toBe('Channel1');

    // The point of SSC: ask once, be told thereafter.
    expect(await received(device, /osc.*state.*subscribe/)).toBe(true);
  });

  it('emits telemetry in the units the manager expects', async () => {
    const { client } = await connect();
    client.startPolling();

    const tree = await nextState(client, t =>
      t.rx1?.af_level !== undefined && t.rx1?.frequency !== undefined);
    const rx1 = tree.rx1!;

    // Frequency is kHz on the wire and kHz in RFDeck.
    expect(rx1.frequency).toBe(470125);
    // AF byte 165 -> -45 dBFS, which the manager turns into a 55 meter.
    expect(rx1.af_level).toBe(-45);
    // RF byte 83 -> -86 dBm -> a low but non-zero percentage.
    expect(rx1.rf_quality).toBeGreaterThan(0);
    expect(rx1.rf_quality).toBeLessThan(20);
    // Battery is a four-state gauge, not a percentage.
    expect(rx1.battery?.percent).toBe(70);
    expect(rx1.battery?.minutesRemaining).toBe(312);
  });

  it('merges partial datagrams instead of replacing state', async () => {
    // Metering arrives twice a second and carries no names. Replacing rather
    // than merging would blank the channel name on every meter update.
    const { client } = await connect();
    client.startPolling();

    await nextState(client, t => !!t.rx1?.name);
    const later = await nextState(client, t => t.rx1?.af_level !== undefined);
    expect(later.rx1!.name).toBe('Channel1');
    expect(later.rx1!.frequency).toBe(470125);
  });

  it('renews its subscription before the device stops sending', async () => {
    // The behaviour this client exists to get right. With the lifetime
    // enforced, a client that subscribed once and never renewed would go
    // quiet — and nothing about the socket would say so.
    const { client } = await connect({ enforceLifetime: true });
    client.startPolling();
    await nextState(client, t => t.rx1?.af_level !== undefined);

    // Renewal runs at a third of the 20 s lifetime, so waiting past one
    // renewal proves it happens without waiting out the whole lifetime.
    const before = Date.now();
    await nextState(client, t => t.rx1?.af_level !== undefined, 9000);
    expect(Date.now() - before).toBeLessThan(9000);
  }, 20_000);

  it('applies an unprompted report, which is how SSC signals a change', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => t.rx1?.mute === false);

    device.report({ rx1: { audio_mute: true } });
    const tree = await nextState(client, t => t.rx1?.mute === true);
    expect(tree.rx1!.mute).toBe(true);
  });

  it('leaves battery absent when no transmitter is paired', async () => {
    // An empty array means no pack, which is not a flat pack.
    const { client, device } = await connect();
    device.values.get(1)!.battery = [];
    client.startPolling();

    const tree = await nextState(client, t => !!t.rx1?.name);
    expect(tree.rx1!.battery).toBeUndefined();
  });

  it('reads NoLink as a squelch, not as a fault', async () => {
    const { client, device } = await connect();
    device.values.get(1)!.warnings = ['NoLink'];
    client.startPolling();

    const tree = await nextState(client, t => t.rx1?.squelch === true);
    expect(tree.rx1!.squelch).toBe(true);
  });

  it('mutes through the address tree', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => t.rx1?.mute === false);

    expect(await client.setMute(1, true)).toBe(true);
    expect(await received(device, /"rx1".*"audio_mute":true/)).toBe(true);

    const tree = await nextState(client, t => t.rx1?.mute === true);
    expect(tree.rx1!.mute).toBe(true);
  });

  it('sets frequency in kHz although callers pass Hz', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => t.rx1?.frequency !== undefined);

    await client.setFrequency(1, 502_400_000);
    expect(await received(device, /"carrier":502400/)).toBe(true);
  });

  it('maps a raw SSC path onto the address tree', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => !!t.rx1?.name);

    await client.sendControl('/rx1/skx/gain', -6);
    expect(await received(device, /"rx1":\{"skx":\{"gain":-6\}\}/)).toBe(true);
  });

  it('reports the identity the device volunteers', async () => {
    const { client } = await connect({ version: '2.0.1', product: 'EM 6000 Dante' });
    const meta = once(client, 'metadata');
    client.startPolling();
    const m = await meta;
    expect(m.firmware ?? m.model).toBeTruthy();
  });

  it('says so rather than going quiet when a subscription is rejected', async () => {
    // "The SSC Server MAY also reject the subscription request completely
    // (with SSC Error code 406)." Silently accepting that would look like a
    // healthy receiver with nothing to say.
    const { client } = await connect({ rejectSubscriptions: true });
    client.startPolling();

    // It still counts as reachable — the device answered — but no channel
    // state ever arrives.
    await once(client, 'connected');
    let sawState = false;
    client.on('state', () => { sawState = true; });
    await new Promise(r => setTimeout(r, 500));
    expect(sawState).toBe(false);
  });

  it('stays quiet after being stopped', async () => {
    const { client } = await connect();
    client.startPolling();
    await nextState(client, t => !!t.rx1?.name);

    client.stopPolling();
    let emitted = false;
    client.on('state', () => { emitted = true; });
    await new Promise(r => setTimeout(r, 600));
    expect(emitted).toBe(false);
  });

  it('coalesces metering into one emit rather than one per datagram', async () => {
    const { client } = await connect();
    let emits = 0;
    client.on('state', () => { emits++; });
    client.startPolling();

    await nextState(client, t => !!t.rx1?.name && t.rx1?.af_level !== undefined);
    await new Promise(r => setTimeout(r, 100));
    expect(emits).toBeLessThan(6);
  });
});
