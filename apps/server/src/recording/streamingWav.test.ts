import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StreamingWav, WAV_HEADER_BYTES } from './pcm';

// A WAV written as the audio arrives.
//
// The header goes down with placeholder sizes and is patched on close, so the
// file is only valid once closed — and a capture that ran for an hour must
// come out with the right sizes, in order, or an operator gets a clip that
// their player refuses or that plays out of sequence. Both are silent failures
// until the moment the recording is needed.

async function tmp(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rfdeck-wav-'));
  return path.join(dir, 'capture.wav');
}

function readHeader(file: string) {
  const b = fs.readFileSync(file);
  return {
    riff:     b.toString('ascii', 0, 4),
    fileSize: b.readUInt32LE(4),
    wave:     b.toString('ascii', 8, 12),
    channels: b.readUInt16LE(22),
    rate:     b.readUInt32LE(24),
    bits:     b.readUInt16LE(34),
    dataSize: b.readUInt32LE(40),
    total:    b.length,
    body:     b.subarray(WAV_HEADER_BYTES),
  };
}

describe('a streamed WAV file', () => {
  it('has the sizes patched in on close', async () => {
    const file = await tmp();
    const w = await StreamingWav.open(file, 48_000);
    w.append(new Int16Array(480));
    w.append(new Int16Array(480));
    const { samples, bytes, error } = await w.close();

    expect(error).toBeNull();
    expect(samples).toBe(960);
    const h = readHeader(file);
    expect(h.riff).toBe('RIFF');
    expect(h.wave).toBe('WAVE');
    expect(h.channels).toBe(1);
    expect(h.rate).toBe(48_000);
    expect(h.bits).toBe(16);
    expect(h.dataSize).toBe(960 * 2);
    expect(h.fileSize).toBe(36 + 960 * 2);
    expect(h.total).toBe(bytes);
  });

  it('keeps chunks in order even though writes are not awaited', async () => {
    // The tap callback cannot wait for the disk. A chain guarantees order;
    // this is the test that would catch it being dropped.
    const file = await tmp();
    const w = await StreamingWav.open(file, 48_000);
    for (let i = 0; i < 50; i++) {
      const chunk = new Int16Array(100).fill(i);
      w.append(chunk);
    }
    await w.close();
    const { body } = readHeader(file);
    for (let i = 0; i < 50; i++) {
      expect(body.readInt16LE(i * 200)).toBe(i);
      expect(body.readInt16LE(i * 200 + 198)).toBe(i);
    }
  });

  it('encodes little-endian regardless of the platform', async () => {
    const file = await tmp();
    const w = await StreamingWav.open(file, 48_000);
    w.append(Int16Array.from([1, -1, 32767, -32768]));
    await w.close();
    const { body } = readHeader(file);
    expect([...body]).toEqual([0x01, 0x00, 0xff, 0xff, 0xff, 0x7f, 0x00, 0x80]);
  });

  it('is an empty but valid file if nothing was ever appended', async () => {
    const file = await tmp();
    const w = await StreamingWav.open(file, 48_000);
    const { samples } = await w.close();
    expect(samples).toBe(0);
    const h = readHeader(file);
    expect(h.dataSize).toBe(0);
    expect(h.total).toBe(WAV_HEADER_BYTES);
  });

  it('reports how much it wrote, so the clip length is known without re-reading', async () => {
    const file = await tmp();
    const w = await StreamingWav.open(file, 48_000);
    w.append(new Int16Array(48_000 * 3));
    expect(w.length).toBe(48_000 * 3);
    await w.close();
  });
});
