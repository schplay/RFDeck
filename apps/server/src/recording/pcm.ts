// Pure audio plumbing for the rolling capture: a ring buffer, a WAV encoder,
// and the FIFO pruning rule. Kept free of I/O so each can be tested directly —
// a clip that is silently truncated, misaligned, or pruned when it should have
// been kept is exactly the kind of fault nobody notices until they need the
// recording.

/**
 * Fixed-size ring of mono 16-bit samples holding the most recent audio.
 *
 * Sized to the pre-roll only. The post-roll is collected live after a
 * detection, so this never has to hold the whole clip — which is what keeps
 * always-on recording across many channels affordable in memory.
 */
export class PcmRing {
  private readonly buf: Int16Array;
  private write = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.buf = new Int16Array(Math.max(1, capacity));
  }

  /** Samples currently held (up to capacity). */
  get length(): number {
    return this.filled;
  }

  push(samples: Int16Array): void {
    const cap = this.buf.length;
    // A push larger than the ring can only leave its tail — anything earlier
    // is already overwritten by definition.
    if (samples.length >= cap) {
      this.buf.set(samples.subarray(samples.length - cap));
      this.write = 0;
      this.filled = cap;
      return;
    }
    const first = Math.min(samples.length, cap - this.write);
    this.buf.set(samples.subarray(0, first), this.write);
    if (first < samples.length) this.buf.set(samples.subarray(first), 0);
    this.write = (this.write + samples.length) % cap;
    this.filled = Math.min(cap, this.filled + samples.length);
  }

  /** The most recent `count` samples, oldest first. Short if not yet filled. */
  read(count: number): Int16Array {
    const n = Math.min(count, this.filled);
    const out = new Int16Array(n);
    if (n === 0) return out;
    const cap = this.buf.length;
    // Walk back n samples from the write head, wrapping.
    const start = (this.write - n + cap) % cap;
    const first = Math.min(n, cap - start);
    out.set(this.buf.subarray(start, start + first), 0);
    if (first < n) out.set(this.buf.subarray(0, n - first), first);
    return out;
  }

  clear(): void {
    this.write = 0;
    this.filled = 0;
  }
}

export const WAV_HEADER_BYTES = 44;

/**
 * A canonical 44-byte RIFF/WAVE header for mono 16-bit PCM.
 *
 * Written by hand rather than pulled from a dependency: the format is fixed,
 * and a clip that will not open in whatever the operator uses is worse than no
 * clip at all.
 */
export function wavHeader(sampleCount: number, sampleRate: number): Buffer {
  const dataBytes = sampleCount * 2;
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);   // file size minus the first 8 bytes
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);              // PCM fmt chunk size
  h.writeUInt16LE(1, 20);               // format: PCM
  h.writeUInt16LE(1, 22);               // channels: mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);  // byte rate
  h.writeUInt16LE(2, 32);               // block align
  h.writeUInt16LE(16, 34);              // bits per sample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const body = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) body.writeInt16LE(samples[i], i * 2);
  return Buffer.concat([wavHeader(samples.length, sampleRate), body]);
}

export interface PrunableClip {
  id: string;
  bytes: number;
  flagged: boolean;
  /** Epoch ms. Oldest goes first. */
  at: number;
}

/**
 * Which clips to delete to fit the budget: oldest first, flagged never.
 *
 * Flagging is the operator saying "keep this", so a flagged clip is not a
 * pruning candidate at any pressure — if flagged clips alone exceed the
 * budget, the caller is told rather than having them quietly deleted.
 */
export function selectForPruning(
  clips: PrunableClip[],
  budgetBytes: number,
): { remove: string[]; freed: number; overBudgetByFlagged: boolean } {
  const total = clips.reduce((n, c) => n + c.bytes, 0);
  if (total <= budgetBytes) return { remove: [], freed: 0, overBudgetByFlagged: false };

  const candidates = clips
    .filter(c => !c.flagged)
    .sort((a, b) => a.at - b.at);

  const remove: string[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (total - freed <= budgetBytes) break;
    remove.push(c.id);
    freed += c.bytes;
  }

  return { remove, freed, overBudgetByFlagged: total - freed > budgetBytes };
}
