import dgram from 'dgram';

// A UDP server that speaks Digital 6000's SSC, for testing the client.
//
// Same caveat as the Shure simulator: it believes the same specification the
// client does, so a shared misreading passes both. What it proves is the part
// that breaks regardless — the subscription lifecycle, merging partial
// datagrams, renewal, and silence detection.
//
// It models the one behaviour that matters most and is impossible to observe
// otherwise: **a subscription expires**. A real EM 6000 pushes until the
// lifetime runs out and then goes quiet without closing anything, which is why
// renewal is the thing a client must get right.

export interface FakeD6000Options {
  channels?: number;
  product?: string;
  version?: string;
  /**
   * Honour subscription lifetimes and stop sending when one lapses.
   *
   * Off by default so most tests are not timing-dependent; the renewal test
   * turns it on.
   */
  enforceLifetime?: boolean;
  /** Reject every subscription with an SSC error, as an overloaded device would. */
  rejectSubscriptions?: boolean;
}

export class FakeDigital6000Device {
  private socket: dgram.Socket;
  private meterTimer: NodeJS.Timeout | null = null;
  private opts: Required<FakeD6000Options>;

  /** Every payload the client has sent, for asserting on what it asked for. */
  readonly received: string[] = [];

  /** When the current metering subscription lapses, in epoch ms. */
  private meterExpiresAt = 0;
  private client: { address: string; port: number } | null = null;

  /** Per-channel values a test can change to drive the client. */
  readonly values = new Map<number, {
    name: string; carrier: number; mute: boolean;
    battery: unknown; warnings: string[];
    rf1: number; rf2: number; af: number; lqi: number;
  }>();

  constructor(options: FakeD6000Options = {}) {
    this.opts = {
      channels: options.channels ?? 2,
      product: options.product ?? 'EM 6000',
      version: options.version ?? '1.1.4.74',
      enforceLifetime: options.enforceLifetime ?? false,
      rejectSubscriptions: options.rejectSubscriptions ?? false,
    };

    for (let ch = 1; ch <= this.opts.channels; ch++) {
      this.values.set(ch, {
        name: `Channel${ch}`,
        carrier: 470100 + ch * 25,
        mute: false,
        battery: ['70%', '5:12'],
        warnings: [],
        // From the specification's own example row.
        rf1: 83, rf2: 53, af: 165, lqi: 128,
      });
    }

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (buf, rinfo) => this.onMessage(buf.toString('utf8'), rinfo));
    this.socket.on('error', () => { /* the client hanging up is not an error */ });
  }

  listen(): Promise<number> {
    return new Promise(resolve => {
      this.socket.bind(0, '127.0.0.1', () => {
        resolve((this.socket.address() as { port: number }).port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.socket.removeAllListeners();
    this.socket.on('error', () => {});
    try { this.socket.close(); } catch { /* already closed */ }
  }

  /** Push an unprompted update, as a real device does when a value changes. */
  report(payload: unknown): void {
    this.send(JSON.stringify(payload));
  }

  /** Let the metering subscription lapse without closing anything. */
  expireSubscription(): void {
    this.meterExpiresAt = 0;
  }

  private onMessage(text: string, rinfo: dgram.RemoteInfo): void {
    this.received.push(text);
    this.client = { address: rinfo.address, port: rinfo.port };

    let json: any;
    try { json = JSON.parse(text); } catch { return; }

    const subscribe = json?.osc?.state?.subscribe;
    if (Array.isArray(subscribe)) return this.onSubscribe(subscribe);

    if (json?.device) return this.sendIdentity();

    // A control write: echo the resulting value, as SSC requires.
    for (const ch of this.values.keys()) {
      const block = json[`rx${ch}`];
      if (!block) continue;
      const v = this.values.get(ch)!;
      if (typeof block.audio_mute === 'boolean') v.mute = block.audio_mute;
      if (typeof block.carrier === 'number') v.carrier = block.carrier;
      this.send(JSON.stringify({
        [`rx${ch}`]: { audio_mute: v.mute, carrier: v.carrier },
      }));
    }
  }

  private onSubscribe(trees: any[]): void {
    if (this.opts.rejectSubscriptions) {
      // "The SSC Server MAY also reject the subscription request completely
      // (with SSC Error code 406)."
      return this.send(JSON.stringify({ osc: { error: [{ desc: 'subscription rejected', code: 406 }] } }));
    }

    for (const tree of trees) {
      const lifetime = Number(tree?.['#']?.lifetime) || 20;

      if ('mm' in tree) {
        this.meterExpiresAt = Date.now() + lifetime * 1000;
        const interval = Number(tree['#']?.min) || 480;
        this.startMetering(interval);
      }

      // The channel tree: answer once now, as a real device does on subscribe.
      const channelKeys = Object.keys(tree).filter(k => /^rx\d+$/.test(k));
      if (channelKeys.length > 0) {
        for (const key of channelKeys) this.sendChannel(Number(key.slice(2)));
      }
    }

    // "The Response to the subscription Request will normally echo the Request."
    this.send(JSON.stringify({ osc: { state: { subscribe: trees } } }));
  }

  private startMetering(intervalMs: number): void {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => {
      // The behaviour that matters: when the subscription lapses the device
      // simply stops, without closing anything or saying why.
      if (this.opts.enforceLifetime && Date.now() > this.meterExpiresAt) return;

      const mm = [...this.values.values()].map(v => [
        v.rf1, 0, v.rf2, 0, 1, 1, v.lqi, v.af, 0,
      ]);
      this.send(JSON.stringify({ mm }));
    }, Math.max(10, intervalMs));
  }

  private sendChannel(ch: number): void {
    const v = this.values.get(ch);
    if (!v) return;
    this.send(JSON.stringify({
      [`rx${ch}`]: {
        name: v.name,
        carrier: v.carrier,
        audio_mute: v.mute,
        active_warnings: v.warnings,
        skx: { battery: v.battery, name: v.name, type: 'SKM 6000' },
      },
    }));
  }

  private sendIdentity(): void {
    this.send(JSON.stringify({
      device: {
        identity: { version: this.opts.version, vendor: 'Sennheiser', product: this.opts.product },
        name: 'Rack 1',
      },
    }));
  }

  private send(payload: string): void {
    const client = this.client;
    if (!client) return;
    try {
      this.socket.send(Buffer.from(payload), client.port, client.address, () => {});
    } catch { /* client has gone */ }
  }
}
