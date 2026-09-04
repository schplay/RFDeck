import { describe, it, expect, afterEach } from 'vitest';
import { probeShure, identifyFromReplies, probeCommands, describeIdentity } from './probe';
import { FakeShureDevice } from './fakeShureDevice';
import { parseSlpAnnouncement, looksLikeAnnouncement } from './slp';

// Identifying a Shure receiver without one to hand.
//
// The decision logic is pure and tested directly, because it is entirely
// inference: the *absence* of a MODEL reply is the evidence that a receiver is
// ULX-D rather than Axient, and "no reply for channel 3" is how a two-channel
// box is told from a four-channel one. Absence is easy to get wrong and hard
// to notice.
//
// The socket path is then exercised against the simulated device.

const open: FakeShureDevice[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
});

async function serve(options: ConstructorParameters<typeof FakeShureDevice>[0] = {}) {
  const device = new FakeShureDevice(options);
  open.push(device);
  return { device, port: await device.listen() };
}

describe('probeCommands', () => {
  it('asks the questions that separate the families', () => {
    const cmds = probeCommands();
    // MODEL is the discriminator: only Axient answers it.
    expect(cmds).toContain('< GET MODEL >');
    expect(cmds).toContain('< GET DEVICE_ID >');
    // And a name query per channel, since ULX-D has no model to count from.
    expect(cmds).toContain('< GET 1 CHAN_NAME >');
    expect(cmds).toContain('< GET 4 CHAN_NAME >');
  });
});

describe('identifyFromReplies', () => {
  it('reads an Axient receiver from its MODEL', () => {
    const id = identifyFromReplies([
      '< REP MODEL {AD4Q                            } >',
      '< REP DEVICE_ID {Rack1                          } >',
      '< REP 1 CHAN_NAME {Lead Vox} >',
      '< REP 2 CHAN_NAME {Ensemble 1} >',
      '< REP 3 CHAN_NAME {Ensemble 2} >',
      '< REP 4 CHAN_NAME {Spare} >',
    ])!;
    expect(id.family).toBe('axtd');
    expect(id.channels).toBe(4);
    expect(id.model).toBe('AD4Q');
    expect(id.deviceId).toBe('Rack1');
  });

  it('infers ULX-D from the absence of a MODEL reply', () => {
    // ULX-D has no MODEL parameter at all, so silence is the signal. Treating
    // "no answer" as "not a Shure device" would lose the whole family.
    const id = identifyFromReplies([
      '< REP DEVICE_ID {Stage Rack} >',
      '< REP FW_VER {2.4.19} >',
      '< REP 1 CHAN_NAME {Pastor} >',
      '< REP 2 CHAN_NAME {Worship 1} >',
    ])!;
    expect(id.family).toBe('ulxd');
    expect(id.model).toBeNull();
    expect(id.channels).toBe(2);
    expect(id.firmware).toBe('2.4.19');
  });

  it('counts channels by which ones answered', () => {
    const id = identifyFromReplies([
      '< REP DEVICE_ID {Rack} >',
      '< REP 1 CHAN_NAME {A} >',
      '< REP 2 CHAN_NAME {B} >',
    ])!;
    expect(id.channels).toBe(2);
  });

  it('believes the channels that answered over the channels a model implies', () => {
    // A model string this build does not recognise, or a receiver with a card
    // pulled: describe what it does, not what a table says it should do.
    const id = identifyFromReplies([
      '< REP MODEL {AD4Q} >',
      '< REP 1 CHAN_NAME {A} >',
      '< REP 2 CHAN_NAME {B} >',
    ])!;
    expect(id.channels).toBe(2);
  });

  it('falls back to the model when no channel answered in time', () => {
    const id = identifyFromReplies(['< REP MODEL {AD4D} >'])!;
    expect(id.channels).toBe(2);
  });

  it('refuses a host that said nothing well-formed', () => {
    // An open port is not identification. Plenty of things listen on a port;
    // almost nothing replies in this framing by accident.
    expect(identifyFromReplies([])).toBeNull();
    expect(identifyFromReplies(['SSH-2.0-OpenSSH_9.2'])).toBeNull();
    expect(identifyFromReplies(['HTTP/1.1 400 Bad Request'])).toBeNull();
  });
});

describe('describeIdentity', () => {
  it('prefers the name the operator gave the device', () => {
    const id = { family: 'axtd' as const, channels: 2, deviceId: 'FOH Rack', firmware: null, model: 'AD4D' };
    expect(describeIdentity(id, '10.0.0.5')).toBe('FOH Rack');
  });

  it('falls back to the model, then to the address', () => {
    expect(describeIdentity(
      { family: 'axtd', channels: 2, deviceId: null, firmware: null, model: 'AD4D' }, '10.0.0.5',
    )).toBe('Shure AD4D');
    expect(describeIdentity(
      { family: 'ulxd', channels: 1, deviceId: null, firmware: null, model: null }, '10.0.0.5',
    )).toBe('Shure receiver (10.0.0.5)');
  });
});

describe('probeShure against a simulated receiver', () => {
  it('identifies an Axient receiver and its channel count', async () => {
    const { port } = await serve({ family: 'axtd', model: 'AD4Q', channels: 4, deviceId: 'Rack1' });
    const id = await probeShure('127.0.0.1', port);
    expect(id).not.toBeNull();
    expect(id!.family).toBe('axtd');
    expect(id!.channels).toBe(4);
    expect(id!.model).toBe('AD4Q');
    expect(id!.deviceId).toBe('Rack1');
  });

  it('identifies a ULX-D receiver, which never answers MODEL', async () => {
    const { port } = await serve({ family: 'ulxd', channels: 2, deviceId: 'Stage Rack' });
    const id = await probeShure('127.0.0.1', port);
    expect(id).not.toBeNull();
    expect(id!.family).toBe('ulxd');
    expect(id!.channels).toBe(2);
    expect(id!.model).toBeNull();
  });

  it('counts a single-channel receiver correctly', async () => {
    const { port } = await serve({ family: 'ulxd', channels: 1 });
    const id = await probeShure('127.0.0.1', port);
    expect(id!.channels).toBe(1);
  });

  it('returns null for a host with nothing listening', async () => {
    // Discovery probes whole subnets; a refused connection is the normal case
    // and must not throw.
    const id = await probeShure('127.0.0.1', 1, 500);
    expect(id).toBeNull();
  });

  it('returns null for a port that answers but not in this protocol', async () => {
    // Something is listening and even talks first — an SSH daemon, say — but
    // says nothing in this framing. Being on the right port is not being the
    // right device.
    const net = await import('net');
    const sockets: import('net').Socket[] = [];
    const server = net.createServer(s => {
      sockets.push(s);
      // resume(), or this socket never reads and so never notices the probe
      // hanging up — leaving server.close() waiting forever. A real device
      // reads its socket; a one-line stand-in has to be told to.
      s.resume();
      s.on('error', () => { /* the probe hanging up is expected */ });
      s.write('SSH-2.0-OpenSSH_9.2\r\n');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    try {
      expect(await probeShure('127.0.0.1', port, 1200)).toBeNull();
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it('survives a device that splits its replies across packets', async () => {
    const { port } = await serve({ family: 'axtd', model: 'AD4D', channels: 2, splitWrites: true });
    const id = await probeShure('127.0.0.1', port);
    expect(id!.model).toBe('AD4D');
    expect(id!.channels).toBe(2);
  });
});

describe('SLP announcements', () => {
  // The payload is comma-separated parenthesised fields; `cd:` carries the
  // device class id. RFDeck does not map it — that needs a proprietary file —
  // but its presence is the cheapest evidence a packet is Shure's.
  it('extracts the device class id', () => {
    expect(parseSlpAnnouncement('(cd:0x1234),(other:x)').dcid).toBe('0x1234');
  });

  it('copes with whitespace and ordering', () => {
    expect(parseSlpAnnouncement('(foo:1), ( cd:ABCD ) ,(bar:2)').dcid).toBe('ABCD');
  });

  it('reports no id rather than guessing when the field is absent', () => {
    expect(parseSlpAnnouncement('(foo:1),(bar:2)').dcid).toBeNull();
    expect(parseSlpAnnouncement('').dcid).toBeNull();
  });

  it('recognises a plausible announcement without being strict about it', () => {
    // The multicast group is Shure's, so arriving on it is already a strong
    // hint and the probe is what actually decides. Being strict here would
    // silently drop models whose announcement differs from the one example
    // available.
    expect(looksLikeAnnouncement('(cd:0x1234)')).toBe(true);
    expect(looksLikeAnnouncement('Shure device announcement')).toBe(true);
    expect(looksLikeAnnouncement('')).toBe(false);
    expect(looksLikeAnnouncement('x'.repeat(5000))).toBe(false);
  });
});
