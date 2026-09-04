import dgram from 'dgram';
import { EventEmitter } from 'events';
import { log } from '../../../logger';
import { HardwareClient, DeviceStateTree, ReceiverState } from '../../HardwareClient';
import {
  SSC_PORT, RENEW_INTERVAL_MS,
  subscriptionMessages, identityMessages, applyMessage,
} from './protocol';

// Sennheiser Digital 6000 — EM 6000, EM 6000 Dante, L 6000.
//
// A separate client from SSCClient despite sharing a vendor and a transport,
// because almost nothing else is shared. SSCClient is built around an HTTPS
// probe chain with a UDP telemetry sidecar; Digital 6000 has no HTTPS
// interface at all — "the SSC Server implemented for Digital 6000 devices
// supports only UDP/IP" — and its address tree is different throughout.
// Bolting a fourth mode onto a 1244-line class that already handles three
// would have made both harder to reason about.
//
// The part that needs care is the subscription lifecycle. This is not a poll:
// the device pushes until a subscription expires, and then goes quiet. A
// lapsed subscription looks exactly like a healthy receiver with nothing to
// say, so renewal is the thing that must not be got wrong.

/** A device that has said nothing for this long is not there. */
const SILENCE_TIMEOUT_MS = 15_000;

const RECONNECT_DELAY_MS = 5_000;

export class Digital6000Client extends EventEmitter implements HardwareClient {
  readonly ip: string;
  readonly port: number;

  private socket: dgram.Socket | null = null;
  private connected = false;
  private stopped = true;

  private renewTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Accumulated state, since a datagram carries only what changed. */
  private channels = new Map<string, ReceiverState>();
  private emitScheduled = false;

  private readonly channelList: number[];

  get isConnected(): boolean { return this.connected; }

  /**
   * @param channels How many receiver channels. The EM 6000 is a two-channel
   *   receiver; the L 6000 is a charger and has none, but is driven the same
   *   way for its identity and slots.
   */
  constructor(ip: string, port: number = SSC_PORT, channels = 2) {
    super();
    this.ip = ip;
    this.port = port || SSC_PORT;
    this.channelList = Array.from({ length: channels }, (_, i) => i + 1);
  }

  startPolling(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stopPolling(): void {
    this.stopped = true;
    this.clearTimers();
    this.close('stopped');
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private open(): void {
    if (this.stopped || this.socket) return;

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (buf, rinfo) => {
      // Datagrams from anywhere else on this ephemeral port are not ours.
      if (rinfo.address !== this.ip) return;
      this.onDatagram(buf.toString('utf8'));
    });

    socket.on('error', (err: Error) => {
      log.debug(`[D6000] ${this.ip} socket error: ${err.message}`);
      this.close('socket error');
      if (!this.stopped) this.scheduleReconnect();
    });

    // Bind to an ephemeral port. The device replies to the source port the
    // subscription arrived from, which is also what lets stateful firewalls
    // pass the telemetry back without an inbound rule.
    socket.bind(0, () => {
      log.debug(`[D6000] ${this.ip} bound :${(socket.address() as any).port} — subscribing on ${this.port}`);
      this.subscribe();
      this.armSilenceTimer();
      this.renewTimer = setInterval(() => this.subscribe(), RENEW_INTERVAL_MS);
    });
  }

  private close(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    const wasConnected = this.connected;
    this.connected = false;

    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => { /* closing */ });
      try { socket.close(); } catch { /* already closed */ }
    }

    if (wasConnected) {
      log.debug(`[D6000] ${this.ip} disconnected (${reason})`);
      this.emit('disconnected', reason);
    }
  }

  private clearTimers(): void {
    for (const t of [this.renewTimer, this.silenceTimer, this.reconnectTimer]) {
      if (t) clearTimeout(t as NodeJS.Timeout);
    }
    this.renewTimer = null;
    this.silenceTimer = null;
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, RECONNECT_DELAY_MS);
  }

  /**
   * A subscription that lapses stops telemetry without closing anything. The
   * device is still there, still answering pings, and simply says nothing —
   * which reads as a working receiver on a quiet channel. Only a silence
   * timeout catches it.
   */
  private armSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      log.warn(`[D6000] ${this.ip} stopped sending — resubscribing`);
      this.close('no data');
      if (!this.stopped) this.scheduleReconnect();
    }, SILENCE_TIMEOUT_MS);
  }

  private send(payload: string): void {
    if (!this.socket) return;
    this.socket.send(Buffer.from(payload), this.port, this.ip, err => {
      if (err) log.debug(`[D6000] ${this.ip} send error: ${err.message}`);
    });
  }

  private subscribe(): void {
    for (const msg of subscriptionMessages(this.channelList)) this.send(msg);
    if (!this.connected) for (const msg of identityMessages()) this.send(msg);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  private onDatagram(text: string): void {
    this.armSilenceTimer();
    this.emit('alive');

    if (!this.connected) {
      this.connected = true;
      log.info(`[D6000] Connected to ${this.ip}:${this.port} (${this.channelList.length}ch)`);
      this.emit('connected');
    }

    let json: any;
    try { json = JSON.parse(text); } catch { return; }

    // An SSC error reply is worth surfacing rather than dropping: the device
    // rejecting a subscription is the difference between "no telemetry because
    // nothing is happening" and "no telemetry because we asked wrongly".
    if (json?.osc?.error) {
      log.warn(`[D6000] ${this.ip} rejected a request: ${JSON.stringify(json.osc.error).slice(0, 200)}`);
      return;
    }

    this.mergeIdentity(json);

    const partial = applyMessage(json, this.channelList);
    let changed = false;
    for (const [key, state] of Object.entries(partial)) {
      if (!state) continue;
      // Merge, never replace. A metering datagram carries no names, and
      // overwriting would blank them twice a second.
      this.channels.set(key, { ...(this.channels.get(key) ?? {}), ...state });
      changed = true;
    }
    if (changed) this.scheduleEmit();
  }

  private mergeIdentity(json: any): void {
    const identity = json?.device?.identity;
    const name = json?.device?.name;
    if (!identity && typeof name !== 'string') return;

    this.emit('metadata', {
      firmware: typeof identity?.version === 'string' ? identity.version : undefined,
      model: typeof identity?.product === 'string' ? identity.product : undefined,
      deviceName: typeof name === 'string' ? name : undefined,
    });
  }

  /** Coalesce a burst of datagrams into one emit, as the Shure client does. */
  private scheduleEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setImmediate(() => {
      this.emitScheduled = false;
      if (!this.connected) return;
      const tree: DeviceStateTree = {};
      for (const [key, state] of this.channels) tree[key] = { ...state };
      this.emit('state', tree);
    });
  }

  // ── Control ───────────────────────────────────────────────────────────────

  async setMute(rxIndex: number, muted: boolean): Promise<boolean> {
    if (!this.connected) return false;
    // "/rx1/audio_mute — sets or returns the audio mute ... value: boolean"
    this.send(JSON.stringify({ [`rx${rxIndex}`]: { audio_mute: muted } }));
    return true;
  }

  async setFrequency(rxIndex: number, frequencyHz: number): Promise<boolean> {
    if (!this.connected) return false;
    // "sets or returns the carrier Frequency in kHz", 470100–713900, step 25.
    this.send(JSON.stringify({
      [`rx${rxIndex}`]: { carrier: Math.round(frequencyHz / 1000) },
    }));
    return true;
  }

  async identify(): Promise<boolean> {
    if (!this.connected) return false;
    // "/rx1/identify" exists per channel; identifying channel 1 flashes the
    // unit, which is what an operator hunting a rack wants.
    this.send(JSON.stringify({ rx1: { identify: true } }));
    return true;
  }

  /**
   * A raw SSC path, for anything not modelled above.
   *
   * "/rx1/skx/gain" becomes {"rx1":{"skx":{"gain":value}}} — the address tree
   * is the message, so a path maps onto it directly.
   */
  async sendControl(path: string, value: any): Promise<boolean> {
    if (!this.connected) return false;
    const parts = path.replace(/^\//, '').split('/').filter(Boolean);
    if (parts.length === 0) return false;

    const body: any = {};
    let node = body;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;

    this.send(JSON.stringify(body));
    return true;
  }
}
