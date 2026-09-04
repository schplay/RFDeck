import { describe, it, expect, afterEach } from 'vitest';
import { ShureClient } from './ShureClient';
import { FakeShureDevice } from './fakeShureDevice';
import type { DeviceStateTree } from '../HardwareClient';

// ShureClient against a device that speaks the same wire format.
//
// This cannot prove the protocol was read correctly — the fake believes the
// same specification the client does, so a shared misreading passes. What it
// does prove is everything between the socket and the `state` event: framing
// across packet boundaries, the metering subscription, coalescing, unit
// conversion, reconnection, and that a value the device calls unknown does not
// arrive as a reading. Those are the parts that break regardless of whether
// the parameter names are right.
//
// The parameter names and value formats are tested separately in
// protocol.test.ts, against strings copied out of Shure's own document.

const open: Array<{ client: ShureClient; device: FakeShureDevice }> = [];

async function connect(options: Parameters<typeof makeDevice>[0] = {}) {
  const device = makeDevice(options);
  const port = await device.listen();
  const client = new ShureClient('127.0.0.1', port, options.model ?? 'AD4D');
  open.push({ client, device });
  return { client, device };
}

function makeDevice(options: ConstructorParameters<typeof FakeShureDevice>[0] = {}) {
  return new FakeShureDevice(options);
}

afterEach(async () => {
  for (const { client, device } of open.splice(0)) {
    client.stopPolling();
    await device.close();
  }
});

/** Wait for a `state` emit whose tree satisfies `predicate`. */
function nextState(
  client: ShureClient,
  predicate: (t: DeviceStateTree) => boolean = () => true,
  timeoutMs = 4000,
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

/**
 * Wait until the device has actually received a command.
 *
 * `setMute` and friends resolve as soon as the bytes are handed to the socket,
 * which is before they reach the other end — asserting on `device.received`
 * immediately after is a race that fails on a fast machine and passes on a
 * slow one.
 */
async function receivedCommand(
  device: FakeShureDevice,
  command: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (device.received.includes(command)) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

function once(client: ShureClient, event: string, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within timeout`)), timeoutMs);
    client.once(event, (payload: any) => { clearTimeout(timer); resolve(payload); });
  });
}

describe('ShureClient', () => {
  it('connects and reports the channels it was told to expect', async () => {
    const { client } = await connect();
    const connected = once(client, 'connected');
    client.startPolling();
    await connected;

    const tree = await nextState(client, t => !!t.rx1?.name && !!t.rx2?.name);
    expect(Object.keys(tree).sort()).toEqual(['rx1', 'rx2']);
    expect(tree.rx1!.name).toBe('Channel1');
  });

  it('emits telemetry in the units the manager expects', async () => {
    const { client } = await connect();
    client.startPolling();

    // The manager applies `100 + af_level` and treats rf_quality as 0-100, the
    // same as for Sennheiser. Emitting dBm or a raw Shure field here would put
    // a plausible but wrong number on every meter.
    const tree = await nextState(client, t => t.rx1?.af_level !== undefined && t.rx1?.rf_quality !== undefined);
    const rx1 = tree.rx1!;

    // Fake reports audio 102 → 102 - 120 = -18 dBFS.
    expect(rx1.af_level).toBe(-18);
    // Frequency stays in kHz: 0578350 is 578.350 MHz.
    expect(rx1.frequency).toBe(578350);
    expect(rx1.rf_quality).toBeGreaterThan(0);
    expect(rx1.rf_quality).toBeLessThanOrEqual(100);
    // Battery bars 004 → 80%.
    expect(rx1.battery?.percent).toBe(80);
    // The hardware states its own runtime, which beats estimating it.
    expect(rx1.battery?.minutesRemaining).toBe(125);
  });

  it('reads both antennas from the metering sample', async () => {
    const { client } = await connect();
    client.startPolling();
    const tree = await nextState(client, t => t.rx1?.rf_quality_b !== undefined);
    // Fake sends rssiA 086, rssiB 065 — different, so a client that copied one
    // into both would pass a weaker assertion than this.
    expect(tree.rx1!.rf_quality).not.toBe(tree.rx1!.rf_quality_b);
  });

  it('subscribes to metering rather than polling for it', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => t.rx1?.rf_quality !== undefined);

    const meterCommands = device.received.filter(m => m.includes('METER_RATE'));
    expect(meterCommands.length).toBeGreaterThanOrEqual(2); // one per channel
    expect(meterCommands[0]).toMatch(/< SET \d METER_RATE \d{5} >/);
  });

  it('survives messages split across packet boundaries', async () => {
    // A real receiver sends no line breaks, so this is the normal case rather
    // than an edge one: TCP segments fall wherever they fall.
    const { client } = await connect({ splitWrites: true });
    client.startPolling();

    const tree = await nextState(client, t => !!t.rx1?.name && t.rx1?.frequency !== undefined);
    expect(tree.rx1!.name).toBe('Channel1');
    expect(tree.rx1!.frequency).toBe(578350);
  });

  it('keeps a channel name containing a space intact', async () => {
    const { client, device } = await connect();
    device.values.get(1)!.name = 'Lead Vox';
    client.startPolling();

    const tree = await nextState(client, t => t.rx1?.name === 'Lead Vox');
    expect(tree.rx1!.name).toBe('Lead Vox');
  });

  it('applies an unprompted report, which is how a real device signals a change', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => t.rx1?.battery?.percent === 80);

    // No GET was sent for this. Shure reports changes on its own, which is why
    // the client does not poll everything on a timer.
    device.report(1, 'TX_BATT_BARS', '002');
    const tree = await nextState(client, t => t.rx1?.battery?.percent === 40);
    expect(tree.rx1!.battery!.percent).toBe(40);
  });

  it('leaves battery absent when the device says it does not know', async () => {
    // 255 is "no transmitter paired". Reported as 0 it is a flat battery, and
    // that is a critical alert for a pack sitting in a case.
    const { client, device } = await connect();
    device.values.get(1)!.battBars = '255';
    device.values.get(1)!.battMins = '65535';
    client.startPolling();

    const tree = await nextState(client, t => !!t.rx1?.name);
    expect(tree.rx1!.battery?.percent).toBeUndefined();
    expect(tree.rx1!.battery?.minutesRemaining).toBeUndefined();
  });

  it('sends mute and believes the report that comes back', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => t.rx1?.mute === false);

    expect(await client.setMute(1, true)).toBe(true);

    const tree = await nextState(client, t => t.rx1?.mute === true);
    expect(tree.rx1!.mute).toBe(true);
    expect(await receivedCommand(device, '< SET 1 AUDIO_MUTE ON >')).toBe(true);
  });

  it('sets frequency in kHz although callers pass Hz', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => t.rx1?.frequency !== undefined);

    await client.setFrequency(1, 602_125_000);
    expect(await receivedCommand(device, '< SET 1 FREQUENCY 602125 >')).toBe(true);
  });

  it('reports metadata the device volunteers', async () => {
    const { client } = await connect({ firmware: '2.1.0' });
    const meta = new Promise<any>(resolve => {
      const seen: any = {};
      client.on('metadata', m => {
        Object.assign(seen, m);
        if (seen.firmware && seen.deviceName) resolve(seen);
      });
    });
    client.startPolling();
    expect((await meta).firmware).toBe('2.1.0');
  });

  it('reconnects after the device drops, the way a power cycle looks', async () => {
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => !!t.rx1?.name);

    const dropped = once(client, 'disconnected');
    device.dropConnections();
    await dropped;
    expect(client.isConnected).toBe(false);

    // The reconnect delay is 5s, so this waits rather than asserting instantly.
    await once(client, 'connected', 12_000);
    expect(client.isConnected).toBe(true);
  }, 20_000);

  it('turns metering off before hanging up', async () => {
    // A receiver left metering into a closed socket keeps doing the work for
    // as long as it stays powered.
    const { client, device } = await connect();
    client.startPolling();
    await nextState(client, t => t.rx1?.rf_quality !== undefined);

    client.stopPolling();

    expect(await receivedCommand(device, '< SET 1 METER_RATE 00000 >')).toBe(true);
  });

  it('stays quiet after being stopped', async () => {
    const { client } = await connect();
    client.startPolling();
    await nextState(client, t => !!t.rx1?.name);

    client.stopPolling();

    let emitted = false;
    client.on('state', () => { emitted = true; });
    await new Promise(r => setTimeout(r, 400));
    expect(emitted).toBe(false);
  });

  it('coalesces a burst of reports into one emit', async () => {
    // GET ALL answers with a dozen REPs back to back and metering adds ten
    // samples a second per channel. One emit per field would push that whole
    // rate through normalisation and out to every connected browser.
    const { client } = await connect();
    let emits = 0;
    client.on('state', () => { emits++; });

    client.startPolling();
    await nextState(client, t => !!t.rx1?.name && t.rx1?.frequency !== undefined);
    await new Promise(r => setTimeout(r, 50));

    // Two channels' worth of GET ALL is ~18 messages; anything near that count
    // means it is emitting per field.
    expect(emits).toBeLessThan(8);
  });

  it('falls back to a warned-about default for an unrecognised model', async () => {
    // Rather than refusing to connect: an operator who typed the model in
    // slightly wrong still gets a working two-channel receiver, and a log line
    // explaining why channels 3 and 4 are missing if it was a quad.
    const { client } = await connect({ model: 'Something Else' });
    client.startPolling();
    const tree = await nextState(client, t => !!t.rx1?.name);
    expect(Object.keys(tree)).toContain('rx1');
  });
});
