import net from 'net';

// A TCP server that speaks Shure command strings, for testing ShureClient.
//
// There is no Shure receiver on the development machine, and a client for
// hardware nobody can plug in is exactly the kind of code that compiles,
// reviews cleanly and fails in a venue. This is the next best thing: a device
// that answers the same wire format, and can be told to misbehave in the ways
// a real one does — splitting a message across two packets, going silent,
// reporting a value as unknown.
//
// It is deliberately literal. Every string it sends is the format from
// docs/SHURE_PROTOCOL.md, so if the specification was misread, the fake is
// wrong in the same direction as the client and the test still passes. That is
// the honest limit of testing without hardware, and it is why the protocol
// module is tested separately against strings copied out of Shure's document.

export interface FakeDeviceOptions {
  /** How many channels to answer for. */
  channels?: number;
  deviceId?: string;
  firmware?: string;
  model?: string;
  /**
   * Send each reply in two writes, split at a random point.
   *
   * A real receiver sends no line breaks and TCP segments fall where they
   * fall, so a message straddling two reads is normal rather than exotic.
   */
  splitWrites?: boolean;
  /**
   * Which family to imitate.
   *
   * ULX-D has no MODEL parameter at all, which is exactly what the probe uses
   * to tell the families apart — so a fake that answers MODEL regardless would
   * make that logic untestable.
   */
  family?: 'axtd' | 'ulxd' | 'slxd';
}

export class FakeShureDevice {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  private meterTimers = new Map<net.Socket, NodeJS.Timeout[]>();
  private writeQueues = new Map<net.Socket, string[]>();
  private opts: Required<FakeDeviceOptions>;

  /** Everything the client has sent, for asserting on what it asked for. */
  readonly received: string[] = [];

  /** Per-channel values a test can change to drive the client. */
  readonly values = new Map<number, {
    name: string; frequency: string; battBars: string; battMins: string;
    mute: 'ON' | 'OFF'; rssiA: string; rssiB: string; audio: string; antennas: string;
    battPercent: string;
  }>();

  constructor(options: FakeDeviceOptions = {}) {
    this.opts = {
      channels: options.channels ?? 2,
      deviceId: options.deviceId ?? 'Rack1',
      firmware: options.firmware ?? '1.2.3',
      model: options.model ?? 'AD4D',
      splitWrites: options.splitWrites ?? false,
      family: options.family ?? 'axtd',
    };

    for (let ch = 1; ch <= this.opts.channels; ch++) {
      this.values.set(ch, {
        name: `Channel${ch}`,
        frequency: '0578350',
        battBars: '004',
        battMins: '00125',
        mute: 'OFF',
        rssiA: '086',
        rssiB: '065',
        audio: '102',
        antennas: 'BB',
        battPercent: '073',
      });
    }

    this.server = net.createServer(socket => this.onConnection(socket));
  }

  listen(): Promise<number> {
    return new Promise(resolve => {
      // Port 0 — the OS picks a free one, so tests never collide.
      this.server.listen(0, '127.0.0.1', () => {
        resolve((this.server.address() as net.AddressInfo).port);
      });
    });
  }

  async close(): Promise<void> {
    for (const timers of this.meterTimers.values()) timers.forEach(clearInterval);
    this.meterTimers.clear();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  /** Drop the connection without warning, the way a power cut does. */
  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  /** Push an unprompted REP, which is how a real device reports a change. */
  report(channel: number, param: string, value: string): void {
    for (const s of this.sockets) this.send(s, `< REP ${channel} ${param} ${value} >`);
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    let buffer = '';

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('>');
        if (end === -1) break;
        const start = buffer.lastIndexOf('<', end);
        if (start !== -1) this.handle(socket, buffer.slice(start, end + 1));
        buffer = buffer.slice(end + 1);
      }
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
      this.meterTimers.get(socket)?.forEach(clearInterval);
      this.meterTimers.delete(socket);
      this.writeQueues.delete(socket);
    });

    socket.on('error', () => { /* the client hanging up is not an error here */ });
  }

  private handle(socket: net.Socket, raw: string): void {
    this.received.push(raw);
    const body = raw.replace(/^</, '').replace(/>$/, '').trim();
    const t = body.split(/\s+/);

    if (t[0] === 'GET' && t[2] === 'ALL') return this.sendAll(socket, Number(t[1]));

    if (t[0] === 'SET' && t[2] === 'METER_RATE') {
      const ch = Number(t[1]);
      const ms = Number(t[3]);
      this.send(socket, `< REP ${ch} METER_RATE ${t[3]} >`);
      return this.setMetering(socket, ch, ms);
    }

    if (t[0] === 'SET' && t[2] === 'AUDIO_MUTE') {
      // SLX-D has no such command; a real one ignores it entirely.
      if (this.opts.family === 'slxd') return;
      const ch = Number(t[1]);
      const v = this.values.get(ch);
      if (v) v.mute = t[3] === 'ON' ? 'ON' : 'OFF';
      // A real device answers a SET with a REP carrying the resulting value.
      return this.send(socket, `< REP ${ch} AUDIO_MUTE ${v?.mute ?? 'OFF'} >`);
    }

    if (t[0] === 'SET' && t[2] === 'FREQUENCY') {
      const ch = Number(t[1]);
      const v = this.values.get(ch);
      if (v) v.frequency = String(t[3]).padStart(7, '0');
      return this.send(socket, `< REP ${ch} FREQUENCY ${v?.frequency} >`);
    }

    if (t[0] === 'GET' && t[1] === 'DEVICE_ID') {
      return this.send(socket, `< REP DEVICE_ID {${this.opts.deviceId.padEnd(31)}} >`);
    }

    if (t[0] === 'GET' && t[1] === 'FW_VER') {
      return this.send(socket, `< REP FW_VER {${this.opts.firmware.padEnd(18)}} >`);
    }

    if (t[0] === 'GET' && t[1] === 'MODEL') {
      // ULX-D has no MODEL parameter. A real one answers nothing at all, and
      // that silence is what identifies the family. Axient and SLX-D both
      // answer, which is why the model string rather than its presence is what
      // decides.
      if (this.opts.family === 'ulxd') return;
      return this.send(socket, `< REP MODEL {${this.opts.model.padEnd(32)}} >`);
    }

    // A per-channel query for a channel this receiver does not have gets no
    // reply — which is how the probe counts channels.
    if (t[0] === 'GET' && t[2] === 'CHAN_NAME') {
      const ch = Number(t[1]);
      const v = this.values.get(ch);
      if (!v) return;
      return this.send(socket, `< REP ${ch} CHAN_NAME {${v.name.padEnd(31)}} >`);
    }
  }

  private sendAll(socket: net.Socket, channel: number): void {
    const v = this.values.get(channel);
    if (!v) return;

    // Device-level first, then the channel — the order a real GET 0 ALL uses.
    this.send(socket, `< REP DEVICE_ID {${this.opts.deviceId.padEnd(31)}} >`);
    this.send(socket, `< REP FW_VER {${this.opts.firmware.padEnd(18)}} >`);
    this.send(socket, `< REP MODEL {${this.opts.model.padEnd(32)}} >`);

    this.send(socket, `< REP ${channel} CHAN_NAME {${v.name.padEnd(31)}} >`);
    this.send(socket, `< REP ${channel} FREQUENCY ${v.frequency} >`);

    // The battery vocabulary differs between families, which is half the point
    // of having a family at all. SLX-D uses Axient's transmitter-side names
    // but reports no charge percentage and has no mute at all.
    const fam = this.opts.family;
    const txNames = fam === 'axtd' || fam === 'slxd';
    this.send(socket, `< REP ${channel} ${txNames ? 'TX_BATT_BARS' : 'BATT_BARS'} ${v.battBars} >`);
    if (fam === 'axtd') {
      this.send(socket, `< REP ${channel} TX_BATT_CHARGE_PERCENT ${v.battPercent} >`);
    } else if (fam === 'ulxd') {
      this.send(socket, `< REP ${channel} BATT_CHARGE ${v.battPercent} >`);
    }
    this.send(socket, `< REP ${channel} ${txNames ? 'TX_BATT_MINS' : 'BATT_RUN_TIME'} ${v.battMins} >`);

    // SLX-D has no mute command, so a real one answers nothing here.
    if (fam !== 'slxd') this.send(socket, `< REP ${channel} AUDIO_MUTE ${v.mute} >`);
    if (fam === 'axtd') this.send(socket, `< REP ${channel} ANTENNA_STATUS ${v.antennas} >`);
  }

  private setMetering(socket: net.Socket, channel: number, intervalMs: number): void {
    const timers = this.meterTimers.get(socket) ?? [];

    if (intervalMs === 0) {
      timers.forEach(clearInterval);
      this.meterTimers.set(socket, []);
      return;
    }

    const timer = setInterval(() => {
      const v = this.values.get(channel);
      if (!v || socket.destroyed) return;

      if (this.opts.family === 'slxd') {
        // < SAMPLE chNum ALL audPeak audRms rfRssi > — three fields, no
        // antenna status and no channel quality.
        this.send(socket, `< SAMPLE ${channel} ALL ${v.audio} ${v.audio} ${v.rssiA} >`);
        return;
      }

      if (this.opts.family === 'ulxd') {
        // < SAMPLE x ALL nn aaa eee > — one RF figure, and nn is only which
        // antenna LEDs are lit.
        this.send(socket, `< SAMPLE ${channel} ALL AX ${v.rssiA} 040 >`);
        return;
      }

      // < SAMPLE chNum ALL qual audBitmap audPeak audRms rfAntStats
      //          rfBitmapA rfRssiA rfBitmapB rfRssiB >
      this.send(socket,
        `< SAMPLE ${channel} ALL 005 031 ${v.audio} ${v.audio} ${v.antennas} ` +
        `31 ${v.rssiA} 31 ${v.rssiB} >`);
    }, Math.max(10, intervalMs));

    timers.push(timer);
    this.meterTimers.set(socket, timers);
  }

  private send(socket: net.Socket, message: string): void {
    if (socket.destroyed) return;

    if (!this.opts.splitWrites || message.length < 4) {
      socket.write(message);
      return;
    }

    // Split mid-message, which is what makes a naive reader lose one.
    //
    // Queued rather than written directly: deferring the second half with a
    // bare setImmediate lets the *next* message's first half overtake it, so
    // the stream arrives interleaved. A real receiver writes one message after
    // another down one socket and never does that — the fake was inventing a
    // failure the client is not required to survive.
    const at = 1 + Math.floor(Math.random() * (message.length - 2));
    this.enqueue(socket, [message.slice(0, at), message.slice(at)]);
  }

  /** Ordered writes, so a split message is never overtaken by the next one. */
  private enqueue(socket: net.Socket, parts: string[]): void {
    const queue = this.writeQueues.get(socket) ?? [];
    queue.push(...parts);
    this.writeQueues.set(socket, queue);
    if (queue.length === parts.length) this.drain(socket);
  }

  private drain(socket: net.Socket): void {
    const queue = this.writeQueues.get(socket);
    if (!queue || queue.length === 0 || socket.destroyed) return;

    socket.write(queue.shift()!);
    if (queue.length > 0) setImmediate(() => this.drain(socket));
  }
}
