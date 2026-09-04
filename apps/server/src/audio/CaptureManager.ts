import { spawn, ChildProcess } from 'child_process';
import { nonstandard } from '@roamhq/wrtc';
import { probeChannelCount, FALLBACK_CHANNELS } from './deviceList';
import { log } from '../logger';

const { RTCAudioSource } = nonstandard;

const SAMPLE_RATE = 48000;
const FRAMES_PER_CHUNK = SAMPLE_RATE / 100; // 10 ms, what RTCAudioSource expects

// Capture from any audio interface, and serve any one of its inputs.
//
// There is no single rig. An installation might have a 2-channel USB box, a
// 32-channel Dante card, the virtual RAVENNA device the AES67 daemon creates,
// or several of them at once — so nothing here assumes a channel count, a
// device count, or which input a given receiver is patched to.
//
// A device is opened once at its full width and demultiplexed into one mono
// source per input. Clients subscribe to an input; the device is opened on the
// first subscriber and closed after the last one leaves, so an idle rack is not
// holding interfaces open.

interface OpenDevice {
  proc: ChildProcess;
  channels: number;
  /** One mono source per input channel, created lazily. */
  sources: Map<number, InstanceType<typeof RTCAudioSource>>;
  /** Per-channel accumulation until a full 10 ms frame is ready. */
  buffers: Map<number, { samples: Int16Array; offset: number }>;
  /** How many peers are listening to each channel. */
  listeners: Map<number, number>;
  /**
   * Raw PCM subscribers per channel — the rolling recorder.
   *
   * Distinct from listeners because they are always on: a tap keeps the
   * device open with nobody listening, which is the whole point of recording
   * continuously rather than only while someone happens to be monitoring.
   */
  taps: Map<number, Set<(samples: Int16Array) => void>>;
  /** Leftover bytes when a chunk does not end on a frame boundary. */
  residue: Buffer;
}

export class CaptureManager {
  private devices = new Map<string, OpenDevice>();

  /** 10 ms of mono samples at the capture rate — one tap callback's payload. */
  static readonly SAMPLE_RATE = SAMPLE_RATE;
  static readonly FRAMES_PER_CHUNK = FRAMES_PER_CHUNK;

  /**
   * Subscribe to raw mono PCM for one input, opening the device if needed.
   *
   * Returns a function that removes the tap. Unlike `acquire`, this creates no
   * WebRTC source and needs no listener: it exists so recording can run
   * continuously on every patched channel.
   */
  addTap(deviceId: string, channel: number, cb: (samples: Int16Array) => void): (() => void) | null {
    const dev = this.open(deviceId);
    if (!dev) return null;
    if (channel < 1 || channel > dev.channels) {
      log.warn(`[capture] ${deviceId} has ${dev.channels} inputs; tap on channel ${channel} refused`);
      return null;
    }

    if (!dev.buffers.has(channel)) {
      dev.buffers.set(channel, { samples: new Int16Array(FRAMES_PER_CHUNK), offset: 0 });
    }
    let set = dev.taps.get(channel);
    if (!set) { set = new Set(); dev.taps.set(channel, set); }
    set.add(cb);

    return () => {
      const current = this.devices.get(deviceId);
      if (current !== dev) return; // device was reopened; nothing to remove
      set!.delete(cb);
      if (set!.size === 0) dev.taps.delete(channel);
      this.closeIfIdle(deviceId);
    };
  }

  // A source for one input of one device. Opens the device if needed.
  acquire(deviceId: string, channel: number): InstanceType<typeof RTCAudioSource> | null {
    const dev = this.open(deviceId);
    if (!dev) return null;

    if (channel < 1 || channel > dev.channels) {
      log.warn(`[capture] ${deviceId} has ${dev.channels} inputs; channel ${channel} requested`);
      return null;
    }

    let source = dev.sources.get(channel);
    if (!source) {
      source = new RTCAudioSource();
      dev.sources.set(channel, source);
      dev.buffers.set(channel, { samples: new Int16Array(FRAMES_PER_CHUNK), offset: 0 });
    }

    dev.listeners.set(channel, (dev.listeners.get(channel) ?? 0) + 1);
    return source;
  }

  // Called when a peer stops listening. Closes the device once nobody is left.
  release(deviceId: string, channel: number): void {
    const dev = this.devices.get(deviceId);
    if (!dev) return;

    const remaining = (dev.listeners.get(channel) ?? 1) - 1;
    if (remaining > 0) {
      dev.listeners.set(channel, remaining);
      return;
    }
    dev.listeners.delete(channel);
    this.closeIfIdle(deviceId);
  }

  // A device stays open while anything wants its audio — a listener or a tap.
  private closeIfIdle(deviceId: string): void {
    const dev = this.devices.get(deviceId);
    if (!dev) return;
    const listening = [...dev.listeners.values()].some(n => n > 0);
    const tapped = [...dev.taps.values()].some(s => s.size > 0);
    if (!listening && !tapped) this.close(deviceId);
  }

  private open(deviceId: string): OpenDevice | null {
    const existing = this.devices.get(deviceId);
    if (existing) return existing;

    // Open at the device's own width — never a fixed stereo assumption.
    // If the probe failed we still have to pick something to open with, but the
    // demuxer strides by this number: guessing wrong scrambles which input maps
    // to which channel, so it is worth saying so loudly.
    const probed = probeChannelCount(deviceId);
    if (probed === null) {
      log.warn(
        `[capture] Unknown channel width for ${deviceId}; opening as ` +
        `${FALLBACK_CHANNELS}-channel. If inputs appear on the wrong channels, ` +
        `this is why.`,
      );
    }
    const channels = probed ?? FALLBACK_CHANNELS;

    const proc = spawn('arecord', [
      '-D', deviceId,
      '-f', 'S16_LE',
      '-r', String(SAMPLE_RATE),
      '-c', String(channels),
      '-t', 'raw',
      '--buffer-size=8192',
      '-q',
    ]);

    const dev: OpenDevice = {
      proc,
      channels,
      sources: new Map(),
      buffers: new Map(),
      listeners: new Map(),
      taps: new Map(),
      residue: Buffer.alloc(0),
    };
    this.devices.set(deviceId, dev);

    log.info(`[capture] Opened ${deviceId} (${channels} input${channels === 1 ? '' : 's'})`);

    proc.stdout?.on('data', (chunk: Buffer) => this.demux(dev, chunk));

    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log.warn(`[arecord ${deviceId}] ${msg}`);
    });

    proc.on('error', (err: Error) => {
      log.error(`[capture] Could not start arecord for ${deviceId}: ${err.message}`);
      this.devices.delete(deviceId);
    });

    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.devices.get(deviceId) === dev && code !== 0 && signal !== 'SIGTERM') {
        log.error(`[capture] ${deviceId} stopped unexpectedly (exit ${code})`);
      }
      if (this.devices.get(deviceId) === dev) this.devices.delete(deviceId);
    });

    return dev;
  }

  // Split interleaved frames into per-channel mono streams.
  //
  // arecord emits arbitrary chunk sizes, so a chunk can end mid-frame; the
  // remainder is carried into the next one. Without that the channel mapping
  // would drift and every input would slowly rotate into its neighbour.
  private demux(dev: OpenDevice, chunk: Buffer): void {
    const buf = dev.residue.length > 0 ? Buffer.concat([dev.residue, chunk]) : chunk;
    const frameBytes = dev.channels * 2;
    const frames = Math.floor(buf.length / frameBytes);
    dev.residue = buf.subarray(frames * frameBytes);

    // Decode channels somebody is listening to OR recording from.
    const active = new Set<number>();
    for (const [ch, n] of dev.listeners) if (n > 0) active.add(ch);
    for (const [ch, s] of dev.taps) if (s.size > 0) active.add(ch);
    if (active.size === 0 || frames === 0) return;

    for (const channel of active) {
      const acc = dev.buffers.get(channel);
      if (!acc) continue;
      const source = dev.sources.get(channel);
      const taps = dev.taps.get(channel);

      const offsetBytes = (channel - 1) * 2;
      for (let f = 0; f < frames; f++) {
        acc.samples[acc.offset++] = buf.readInt16LE(f * frameBytes + offsetBytes);

        if (acc.offset >= acc.samples.length) {
          source?.onData({
            samples: acc.samples,
            sampleRate: SAMPLE_RATE,
            bitsPerSample: 16,
            channelCount: 1,
            numberOfFrames: FRAMES_PER_CHUNK,
          });
          // Taps get their own copy: this buffer is reused for the next frame,
          // and a recorder holding a reference would see it overwritten.
          if (taps?.size) {
            const copy = acc.samples.slice();
            for (const cb of taps) {
              try { cb(copy); } catch (err: any) {
                log.warn(`[capture] Tap on ${channel} threw: ${err?.message}`);
              }
            }
          }
          acc.offset = 0;
        }
      }
    }
  }

  private close(deviceId: string): void {
    const dev = this.devices.get(deviceId);
    if (!dev) return;
    log.info(`[capture] Closing ${deviceId} — no listeners`);
    dev.proc.kill('SIGTERM');
    this.devices.delete(deviceId);
  }

  /** Inputs currently open, for diagnostics. */
  activeChannels(): Array<{ deviceId: string; channel: number; listeners: number }> {
    const out: Array<{ deviceId: string; channel: number; listeners: number }> = [];
    for (const [deviceId, dev] of this.devices) {
      for (const [channel, listeners] of dev.listeners) {
        if (listeners > 0) out.push({ deviceId, channel, listeners });
      }
    }
    return out;
  }

  stopAll(): void {
    for (const deviceId of [...this.devices.keys()]) this.close(deviceId);
  }
}
