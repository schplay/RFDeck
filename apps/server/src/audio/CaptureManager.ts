import { spawn, ChildProcess } from 'child_process';
import { nonstandard } from '@roamhq/wrtc';
import { probeChannelCount } from './deviceList';
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
  /** Leftover bytes when a chunk does not end on a frame boundary. */
  residue: Buffer;
}

export class CaptureManager {
  private devices = new Map<string, OpenDevice>();

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

    const anyLeft = [...dev.listeners.values()].some(n => n > 0);
    if (!anyLeft) this.close(deviceId);
  }

  private open(deviceId: string): OpenDevice | null {
    const existing = this.devices.get(deviceId);
    if (existing) return existing;

    // Open at the device's own width — never a fixed stereo assumption.
    const channels = probeChannelCount(deviceId);

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

    // Only decode channels somebody is actually listening to.
    const active = [...dev.listeners.keys()].filter(ch => (dev.listeners.get(ch) ?? 0) > 0);
    if (active.length === 0 || frames === 0) return;

    for (const channel of active) {
      const acc = dev.buffers.get(channel);
      const source = dev.sources.get(channel);
      if (!acc || !source) continue;

      const offsetBytes = (channel - 1) * 2;
      for (let f = 0; f < frames; f++) {
        acc.samples[acc.offset++] = buf.readInt16LE(f * frameBytes + offsetBytes);

        if (acc.offset >= acc.samples.length) {
          source.onData({
            samples: acc.samples,
            sampleRate: SAMPLE_RATE,
            bitsPerSample: 16,
            channelCount: 1,
            numberOfFrames: FRAMES_PER_CHUNK,
          });
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
