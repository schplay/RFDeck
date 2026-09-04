import net from 'net';
import { EventEmitter } from 'events';
import { log } from '../../logger';
import {
  HardwareClient, DeviceStateTree, ReceiverState,
} from '../HardwareClient';
import {
  ShureFamily, FAMILIES, identifyModel,
  splitMessages, parseMessage, parseSample,
  parseBatteryBars, batteryBarsToPercent, parseBatteryPercent, parseBatteryMinutes,
  parseFrequencyKhz, audioToDbfs, rssiToPercent,
  getAll, setMeterRate, setMute as buildSetMute, setFrequency as buildSetFrequency,
} from './protocol';

// Shure receivers over the "command strings" protocol: ASCII in angle brackets
// on TCP 2202. Covers Axient Digital (AD4D/AD4Q), ULX-D and QLX-D.
//
// See docs/SHURE_PROTOCOL.md for where every format came from, and for the
// list of things that cannot be confirmed without hardware on the bench.
//
// The design point worth knowing: this class holds a socket and a channel
// cache and nothing else. All the format knowledge is in ./protocol, which is
// pure and tested, because that is the part that can be got right without a
// receiver to try it on.

const SHURE_PORT = 2202;

/**
 * How often the receiver sends metering.
 *
 * 100 ms is what micboard uses and what the meters want. It is a per-channel
 * subscription the device honours until told otherwise, so this is a
 * subscription rate rather than a poll interval — RFDeck does not ask again.
 */
const METER_INTERVAL_MS = 100;

/**
 * Re-query the slow-moving parameters occasionally.
 *
 * REP arrives unprompted whenever a value changes, so this is belt-and-braces
 * rather than the main path: it recovers the case where a change was sent
 * while the socket was down and no further change follows for the rest of the
 * show.
 */
const REFRESH_INTERVAL_MS = 30_000;

/** A device that has said nothing at all for this long is not there. */
const SILENCE_TIMEOUT_MS = 15_000;

const RECONNECT_DELAY_MS = 5_000;

export class ShureClient extends EventEmitter implements HardwareClient {
  readonly ip: string;
  readonly port: number;

  private family: ShureFamily;
  private channelCount: number;

  private socket: net.Socket | null = null;
  private buffer = '';
  private connected = false;
  private stopped = true;

  private refreshTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;

  /** Accumulated per-channel state, since telemetry arrives a field at a time. */
  private channels = new Map<number, ReceiverState>();
  /**
   * Channels that have reported a real charge percentage, so the coarse
   * five-bar fallback never overwrites it afterwards.
   */
  private hasChargePercent = new Set<number>();
  /** Emitting on every field would be a storm; coalesce into one tick. */
  private emitScheduled = false;

  get isConnected(): boolean { return this.connected; }

  /**
   * @param model The inventory row's model string, which decides both the
   *   command vocabulary and how many channels to ask about. An unrecognised
   *   model falls back to Axient's two channels — see the warning below.
   */
  constructor(ip: string, port: number = SHURE_PORT, model = '') {
    super();
    this.ip = ip;
    this.port = port || SHURE_PORT;

    const identified = identifyModel(model);
    if (identified) {
      this.family = identified.family;
      this.channelCount = identified.channels;
    } else {
      // Not silent, because both halves of this guess have consequences: the
      // wrong vocabulary means every GET goes unanswered and the device looks
      // dead, and the wrong channel count means either half a receiver missing
      // or two channels that never report.
      log.warn(
        `[Shure] ${ip}: model "${model}" not recognised — assuming a 2-channel ` +
        `Axient Digital. If channels are missing or nothing reports, set the ` +
        `model on the inventory row (AD4D, AD4Q, ULXD4D, QLXD4...).`,
      );
      this.family = 'axtd';
      this.channelCount = 2;
    }
  }

  private get spec() { return FAMILIES[this.family]; }

  private get channelList(): number[] {
    return Array.from({ length: this.channelCount }, (_, i) => i + 1);
  }

  startPolling(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stopPolling(): void {
    this.stopped = true;
    this.clearTimers();
    this.teardownSocket('stopped');
  }

  // ── Connection ────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped || this.socket) return;

    const socket = new net.Socket();
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on('connect', () => {
      this.connected = true;
      this.buffer = '';
      log.info(`[Shure] Connected to ${this.ip}:${this.port} (${this.spec.label}, ${this.channelCount}ch)`);
      this.emit('connected');
      this.emit('alive');

      // Ask for everything once, then subscribe to metering. GET ALL covers
      // names, frequencies, battery and mute in one exchange; after that the
      // device reports changes unprompted.
      for (const ch of this.channelList) {
        this.write(getAll(ch));
        this.write(setMeterRate(ch, METER_INTERVAL_MS));
      }

      this.armSilenceTimer();
      this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    });

    socket.on('data', (chunk: Buffer) => this.onData(chunk));

    socket.on('error', (err: Error) => {
      // Logged at debug: a receiver that is switched off produces one of these
      // every reconnect attempt, and at info that is the whole journal.
      log.debug(`[Shure] ${this.ip} socket error: ${err.message}`);
    });

    socket.on('close', () => this.onClose('connection closed'));

    socket.connect(this.port, this.ip);
  }

  private onClose(reason: string): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    this.clearTimers();

    if (wasConnected) this.emit('disconnected', reason);
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Tell the receiver to stop metering before dropping the socket.
   *
   * Without it the device keeps generating samples into a connection nobody is
   * reading, for as long as it stays powered.
   */
  private teardownSocket(reason: string): void {
    const socket = this.socket;
    if (!socket) return;

    const wasConnected = this.connected;
    if (wasConnected) {
      for (const ch of this.channelList) this.write(setMeterRate(ch, 0));
    }

    this.socket = null;
    this.connected = false;
    socket.removeAllListeners();
    socket.on('error', () => { /* nothing left to report to */ });

    if (wasConnected) {
      // end(), not destroy(). destroy() tears the socket down without flushing
      // what is queued, so the METER_RATE 0 above would often never reach the
      // wire — and the receiver would keep metering into a dead connection for
      // as long as it stayed powered. end() flushes first, then closes.
      //
      // A socket that will not flush must not hold the process open either, so
      // it is destroyed after a moment regardless. unref() so this timer alone
      // never keeps Node alive.
      socket.end();
      const kill = setTimeout(() => socket.destroy(), 1000);
      kill.unref?.();
    } else {
      socket.destroy();
    }

    log.debug(`[Shure] ${this.ip} disconnected (${reason})`);
  }

  private clearTimers(): void {
    for (const t of [this.refreshTimer, this.reconnectTimer, this.silenceTimer]) {
      if (t) clearTimeout(t as NodeJS.Timeout);
    }
    this.refreshTimer = null;
    this.reconnectTimer = null;
    this.silenceTimer = null;
  }

  /**
   * A receiver metering every 100 ms and saying nothing for fifteen seconds is
   * not there, whatever TCP believes. A half-open socket survives a power cut
   * indefinitely, and the channel would sit on the dashboard looking healthy.
   */
  private armSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      log.warn(`[Shure] ${this.ip} stopped responding — reconnecting`);
      this.teardownSocket('no data');
      this.emit('disconnected', 'no response');
      if (!this.stopped) this.scheduleReconnect();
    }, SILENCE_TIMEOUT_MS);
  }

  private write(command: string): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(command);
  }

  private refresh(): void {
    for (const ch of this.channelList) this.write(getAll(ch));
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.armSilenceTimer();
    this.emit('alive');

    const { messages, remainder } = splitMessages(this.buffer + chunk.toString('utf8'));
    this.buffer = remainder;

    for (const raw of messages) {
      const msg = parseMessage(raw);
      if (msg) this.handle(msg);
    }
  }

  private handle(msg: ReturnType<typeof parseMessage>): void {
    if (!msg) return;

    if (msg.type === 'SAMPLE') return this.handleSample(msg);
    if (msg.type !== 'REP' && msg.type !== 'REPORT') return;

    // Device-level: identity, not channel telemetry.
    if (msg.channel === null) return this.handleDeviceReport(msg);

    const ch = this.state(msg.channel);
    const p = this.spec.param;

    switch (msg.param) {
      case p.channelName:
        ch.name = msg.value;
        break;

      case p.frequency:
        ch.frequency = parseFrequencyKhz(msg.value);
        break;

      case p.battPercent: {
        // The real 0-100 charge figure. Both families report one, and it is
        // strictly better than inferring a percentage from five bars.
        const percent = parseBatteryPercent(msg.value);
        if (percent !== null) {
          ch.battery = { ...ch.battery, percent };
          this.hasChargePercent.add(msg.channel);
        }
        break;
      }

      case p.battBars: {
        // The fallback, for a transmitter that reports bars but no charge.
        // Never allowed to overwrite a real percentage with a rounder one:
        // 4 bars would drag a reported 71% to 80%.
        if (this.hasChargePercent.has(msg.channel)) break;
        const percent = batteryBarsToPercent(parseBatteryBars(msg.value));
        // Leave battery absent when unknown rather than writing 0 — no paired
        // transmitter is not a flat one, and the difference is an alert.
        if (percent !== undefined) ch.battery = { ...ch.battery, percent };
        break;
      }

      case p.battMins: {
        const mins = parseBatteryMinutes(msg.value);
        if (mins !== null) ch.battery = { ...ch.battery, minutesRemaining: mins };
        break;
      }

      case p.mute:
        ch.mute = msg.value === 'ON';
        break;

      default:
        // The rest are optional per family, so they cannot be `case` labels —
        // an undefined label would match any REP whose parameter name we do
        // not recognise, and quietly write garbage into the channel.
        if (p.audioLevel && msg.param === p.audioLevel) {
          const db = audioToDbfs(msg.value, this.family);
          if (db !== null) ch.af_level = db;
          break;
        }

        if (p.rfLevel && msg.param === p.rfLevel) {
          // RSSI is indexed by antenna as well as channel:
          // "< REP 1 RSSI 1 083 >".
          const [antenna, level] = msg.args.length >= 2 ? msg.args : [null, msg.args[0]];
          const percent = rssiToPercent(level ?? '', this.family);
          if (percent === null) break;
          if (antenna === '2') ch.rf_quality_b = percent;
          else ch.rf_quality = percent;
          break;
        }

        return; // Nothing above cares; do not schedule an emit for it.
    }

    this.scheduleEmit();
  }

  private handleSample(msg: NonNullable<ReturnType<typeof parseMessage>>): void {
    const reading = parseSample(msg, this.family);
    if (!reading) return;

    const ch = this.state(reading.channel);

    if (reading.audioDbfs !== null) ch.af_level = reading.audioDbfs;

    if (reading.rfPercent.length > 0) {
      ch.rf_quality = reading.rfPercent[0];
      // A single-antenna receiver reports one figure; showing B as zero would
      // read as a dead diversity antenna rather than as one that is not there.
      ch.rf_quality_b = reading.rfPercent[1] ?? reading.rfPercent[0];
    }

    this.scheduleEmit();
  }

  private handleDeviceReport(msg: NonNullable<ReturnType<typeof parseMessage>>): void {
    switch (msg.param) {
      case 'DEVICE_ID':
        this.emit('metadata', { deviceName: msg.value });
        break;
      case 'FW_VER':
        this.emit('metadata', { firmware: msg.value });
        break;
      case 'MODEL':
        this.emit('metadata', { model: msg.value });
        break;
    }
  }

  private state(channel: number): ReceiverState {
    let s = this.channels.get(channel);
    if (!s) { s = {}; this.channels.set(channel, s); }
    return s;
  }

  /**
   * Coalesce a burst of field updates into one `state` emit.
   *
   * A GET ALL answers with dozens of REPs back to back, and metering adds ten
   * samples a second per channel. Emitting per field would push that whole
   * rate through normalisation and out over the socket to every browser.
   */
  private scheduleEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setImmediate(() => {
      this.emitScheduled = false;
      if (!this.connected) return;

      const tree: DeviceStateTree = {};
      for (const [channel, state] of this.channels) {
        tree[`rx${channel}`] = { ...state };
      }
      this.emit('state', tree);
    });
  }

  // ── Control ───────────────────────────────────────────────────────────────

  async setMute(rxIndex: number, muted: boolean): Promise<boolean> {
    if (!this.connected) return false;
    this.write(buildSetMute(rxIndex, muted, this.family));
    // Fire and forget, like the Sennheiser path: the device answers with a REP
    // carrying the new value, and that telemetry is what the UI believes.
    return true;
  }

  async setFrequency(rxIndex: number, frequencyHz: number): Promise<boolean> {
    if (!this.connected) return false;
    // Callers pass Hz; Shure sets in kHz.
    this.write(buildSetFrequency(rxIndex, Math.round(frequencyHz / 1000)));
    return true;
  }

  async sendControl(path: string, value: any): Promise<boolean> {
    if (!this.connected) return false;
    // The escape hatch: a raw command string for anything not modelled above.
    const command = path.startsWith('<') ? path : `< SET ${path} ${value} >`;
    this.write(command);
    return true;
  }

  /**
   * Axient has no "flash the display" command over this protocol, so the
   * button reports that nothing happened rather than appearing to work.
   */
  async identify(): Promise<boolean> {
    return false;
  }
}
