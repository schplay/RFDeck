import { nonstandard } from '@roamhq/wrtc';
import { CaptureManager } from './CaptureManager';
import { mixFrames, levelOf, FrameQueue, Level } from './mix';
import { log } from '../logger';

const { RTCAudioSource } = nonstandard;

// One listen bus, for one peer.
//
// Several channels summed into one track, mixed here rather than in the
// browser. That is the whole of the performance argument from the plan: the
// capture layer is per device and every channel is already demuxed for the
// recorder, so adding members costs nothing to capture; the only new work is
// the sum, which is 480 additions per member per 10 ms. Sending N tracks and
// letting the browser mix would be N encoders per listener, which is where the
// cost would actually land. Mixing first keeps it at one track per peer — the
// same as listening to one channel today.
//
// A side effect worth having: the mix has the audio itself, so it can meter
// each member from the samples. That is the first point in RFDeck at which a
// level comes from audio rather than from a number a receiver reported.

const TICK_MS = 10;

interface Member {
  key: string;
  deviceId: string;
  channel: number;
  queue: FrameQueue;
  untap: () => void;
  level: Level;
}

export class Mixer {
  readonly source = new RTCAudioSource();
  private members = new Map<string, Member>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly frameLength: number;
  private readonly sampleRate: number;

  constructor(private readonly capture: CaptureManager) {
    this.sampleRate = CaptureManager.SAMPLE_RATE;
    this.frameLength = CaptureManager.FRAMES_PER_CHUNK;
  }

  createTrack() { return this.source.createTrack(); }

  /** The channel keys currently on the bus. */
  keys(): string[] { return [...this.members.keys()]; }

  /** Last measured level per member, for a meter drawn from the audio. */
  levels(): Record<string, Level> {
    const out: Record<string, Level> = {};
    for (const [k, m] of this.members) out[k] = m.level;
    return out;
  }

  /**
   * Add a channel to the bus. Returns false if the input could not be opened.
   * Idempotent: adding a member that is already on the bus does nothing.
   */
  add(key: string, deviceId: string, channel: number): boolean {
    if (this.members.has(key)) return true;
    const queue = new FrameQueue();
    const member: Member = {
      key, deviceId, channel, queue, untap: () => {}, level: { peak: 0, rms: 0 },
    };
    const untap = this.capture.addTap(deviceId, channel, frame => {
      queue.push(frame);
    });
    if (!untap) return false;
    member.untap = untap;
    this.members.set(key, member);
    this.ensureTicking();
    return true;
  }

  remove(key: string): void {
    const m = this.members.get(key);
    if (!m) return;
    m.untap();
    this.members.delete(key);
    if (this.members.size === 0) this.stopTicking();
  }

  /** Make the bus exactly these members, adding and removing as needed. */
  set(wanted: Array<{ key: string; deviceId: string; channel: number }>): { added: string[]; failed: string[] } {
    const keep = new Set(wanted.map(w => w.key));
    for (const key of [...this.members.keys()]) if (!keep.has(key)) this.remove(key);
    const added: string[] = [];
    const failed: string[] = [];
    for (const w of wanted) {
      if (this.add(w.key, w.deviceId, w.channel)) added.push(w.key);
      else failed.push(w.key);
    }
    return { added, failed };
  }

  close(): void {
    for (const key of [...this.members.keys()]) this.remove(key);
    this.stopTicking();
  }

  // One frame per member per tick, summed, out to the track. A member with
  // nothing ready contributes silence for that tick rather than holding the
  // others up; a member that has run ahead has already had its oldest frames
  // dropped by its queue.
  private tick = (): void => {
    const frames: Int16Array[] = [];
    for (const m of this.members.values()) {
      const f = m.queue.shift();
      if (f) {
        m.level = levelOf(f);
        frames.push(f);
      } else {
        m.level = { peak: 0, rms: 0 };
      }
    }
    const samples = mixFrames(frames, this.frameLength);
    try {
      this.source.onData({
        samples,
        sampleRate: this.sampleRate,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: this.frameLength,
      });
    } catch (err: any) {
      // The peer has gone; the owner will close us. Not worth a log per tick.
      this.stopTicking();
      log.debug(`[mixer] Source rejected data: ${err?.message}`);
    }
  };

  private ensureTicking(): void {
    if (this.timer) return;
    this.timer = setInterval(this.tick, TICK_MS);
  }

  private stopTicking(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
