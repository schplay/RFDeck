// The arithmetic of a listen bus, kept apart from sockets and timers.
//
// Several channels summed into one, attenuated by the number of channels so
// the sum cannot clip, and a level reading per member so a meter can be drawn
// from the audio itself rather than from a number a receiver reported.

/**
 * Sum `frames` into one, scaled by 1/N.
 *
 * 1/N rather than a limiter, at least to begin with: it is predictable — two
 * channels are each exactly half as loud as they were alone — and it has no
 * state to get wrong under load. The cost is that a bus of eight quiet
 * channels is quiet; the operator has a volume control for that.
 *
 * Frames shorter than `length` are treated as silence beyond their end, so a
 * member that is momentarily behind contributes what it has rather than
 * stalling the mix.
 */
export function mixFrames(frames: Int16Array[], length: number): Int16Array {
  const out = new Int16Array(length);
  const n = frames.length;
  if (n === 0) return out;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const f of frames) sum += i < f.length ? f[i] : 0;
    const v = sum / n;
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : (v | 0);
  }
  return out;
}

export interface Level {
  /** Highest absolute sample in the frame, 0–1. */
  peak: number;
  /** Root mean square of the frame, 0–1. */
  rms: number;
}

/** Peak and RMS of one frame, as fractions of full scale. */
export function levelOf(frame: Int16Array): Level {
  if (frame.length === 0) return { peak: 0, rms: 0 };
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < frame.length; i++) {
    const a = Math.abs(frame[i]);
    if (a > peak) peak = a;
    sumSq += frame[i] * frame[i];
  }
  return {
    peak: peak / 32768,
    rms: Math.sqrt(sumSq / frame.length) / 32768,
  };
}

/**
 * A bounded queue of frames for one bus member.
 *
 * Members arrive on their own device's clock. A ticker pulls one frame per
 * member per tick; if a member has none ready it contributes silence for that
 * tick, and if it has run ahead the oldest frames are dropped so the queue
 * cannot grow without bound. A device a fraction of a percent fast would
 * otherwise accumulate a whole second of latency every few minutes.
 */
export class FrameQueue {
  private frames: Int16Array[] = [];

  constructor(private readonly maxDepth = 5) {}

  push(frame: Int16Array): void {
    this.frames.push(frame);
    while (this.frames.length > this.maxDepth) this.frames.shift();
  }

  /** The oldest frame, or null if none is ready. */
  shift(): Int16Array | null {
    return this.frames.shift() ?? null;
  }

  get depth(): number { return this.frames.length; }
}
