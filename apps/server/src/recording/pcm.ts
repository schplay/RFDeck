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

/**
 * A WAV file written as the audio arrives, rather than assembled at the end.
 *
 * Detection clips are short — a pre-roll and a few seconds after — so they are
 * built in memory and written once. A capture on request can run for an hour,
 * which at 48 kHz mono 16-bit is around 345 MB per channel: holding that in
 * memory across several channels would take the server down for the sake of a
 * feature meant to help it. So the header goes down first with placeholder
 * sizes, PCM is appended as it comes, and the sizes are patched in on close.
 *
 * Writes are chained so chunks land in order even though the tap callback
 * cannot wait for the disk. `close` waits for the chain before patching, so a
 * file is never closed with audio still in flight.
 */
export class StreamingWav {
  private samples = 0;
  private chain: Promise<void> = Promise.resolve();
  private failed: Error | null = null;

  // The FileHandle itself, never its bare descriptor. A FileHandle closes its
  // descriptor when it is garbage-collected, so taking `handle.fd` and letting
  // the handle go meant the file was closed underneath the writes — and the
  // number could then be reused for something else entirely. The first version
  // of this did exactly that and was caught by its own tests.
  private constructor(
    private readonly handle: import('fs/promises').FileHandle,
    private readonly sampleRate: number,
    readonly path: string,
  ) {}

  static async open(filePath: string, sampleRate: number): Promise<StreamingWav> {
    const fsp = await import('fs/promises');
    const handle = await fsp.open(filePath, 'w');
    await handle.write(wavHeader(0, sampleRate), 0, WAV_HEADER_BYTES, 0);
    return new StreamingWav(handle, sampleRate, filePath);
  }

  /** Samples written so far — what the file will say when closed. */
  get length(): number { return this.samples; }

  append(chunk: Int16Array): void {
    if (this.failed) return;
    const body = Buffer.alloc(chunk.length * 2);
    for (let i = 0; i < chunk.length; i++) body.writeInt16LE(chunk[i], i * 2);
    const offset = WAV_HEADER_BYTES + this.samples * 2;
    this.samples += chunk.length;
    this.chain = this.chain
      .then(async () => { await this.handle.write(body, 0, body.length, offset); })
      .catch(err => {
        // Remember the first failure and stop trying; the caller learns of it
        // on close, where it can be reported against the capture.
        if (!this.failed) this.failed = err instanceof Error ? err : new Error(String(err));
      });
  }

  /** Patch the sizes and close. Returns what was actually written. */
  async close(): Promise<{ samples: number; bytes: number; error: Error | null }> {
    await this.chain;
    try {
      await this.handle.write(wavHeader(this.samples, this.sampleRate), 0, WAV_HEADER_BYTES, 0);
    } catch (err: any) {
      if (!this.failed) this.failed = err instanceof Error ? err : new Error(String(err));
    }
    await this.handle.close().catch(() => {});
    return {
      samples: this.samples,
      bytes: WAV_HEADER_BYTES + this.samples * 2,
      error: this.failed,
    };
  }
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
