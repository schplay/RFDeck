import { describe, it, expect } from 'vitest';
import { PcmRing, wavHeader, encodeWav, selectForPruning, WAV_HEADER_BYTES } from './pcm';

// These decide whether a clip is usable. A ring that drops or misorders
// samples yields audio that does not match the incident; a malformed header
// yields a file that will not open; a pruning rule that ignores flags deletes
// the recording an operator deliberately kept. None of it announces itself —
// it is only discovered when someone needs the clip.

const ramp = (n: number, from = 0) =>
  Int16Array.from({ length: n }, (_, i) => (from + i) % 30000);

describe('PcmRing', () => {
  it('returns what was written, oldest first', () => {
    const ring = new PcmRing(10);
    ring.push(ramp(4));
    expect([...ring.read(4)]).toEqual([0, 1, 2, 3]);
  });

  it('is short rather than padded before it fills', () => {
    const ring = new PcmRing(100);
    ring.push(ramp(3));
    expect(ring.length).toBe(3);
    expect([...ring.read(50)]).toEqual([0, 1, 2]);
  });

  it('keeps the most recent samples once it wraps', () => {
    const ring = new PcmRing(5);
    ring.push(ramp(8)); // 0..7
    expect(ring.length).toBe(5);
    expect([...ring.read(5)]).toEqual([3, 4, 5, 6, 7]);
  });

  it('stays ordered across many small pushes that wrap repeatedly', () => {
    // The realistic pattern: 10 ms frames arriving forever into a short ring.
    const ring = new PcmRing(7);
    for (let i = 0; i < 20; i++) ring.push(Int16Array.of(i));
    expect([...ring.read(7)]).toEqual([13, 14, 15, 16, 17, 18, 19]);
  });

  it('handles a push larger than the ring by keeping its tail', () => {
    const ring = new PcmRing(4);
    ring.push(ramp(10)); // 0..9
    expect([...ring.read(4)]).toEqual([6, 7, 8, 9]);
  });

  it('reads fewer than asked without inventing samples', () => {
    const ring = new PcmRing(5);
    ring.push(ramp(2));
    expect(ring.read(5).length).toBe(2);
  });
});

describe('wav encoding', () => {
  it('writes a 44-byte canonical header', () => {
    const h = wavHeader(48_000, 48_000);
    expect(h.length).toBe(WAV_HEADER_BYTES);
    expect(h.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.toString('ascii', 8, 12)).toBe('WAVE');
    expect(h.toString('ascii', 12, 16)).toBe('fmt ');
    expect(h.toString('ascii', 36, 40)).toBe('data');
  });

  it('declares mono 16-bit at the given rate, with matching sizes', () => {
    const samples = 4_800; // 100 ms
    const h = wavHeader(samples, 48_000);
    expect(h.readUInt16LE(20)).toBe(1);        // PCM
    expect(h.readUInt16LE(22)).toBe(1);        // mono
    expect(h.readUInt32LE(24)).toBe(48_000);   // sample rate
    expect(h.readUInt32LE(28)).toBe(96_000);   // byte rate = rate * 2
    expect(h.readUInt16LE(32)).toBe(2);        // block align
    expect(h.readUInt16LE(34)).toBe(16);       // bits
    expect(h.readUInt32LE(40)).toBe(samples * 2);
    expect(h.readUInt32LE(4)).toBe(36 + samples * 2);
  });

  it('round-trips sample values, including negatives', () => {
    const input = Int16Array.of(0, 1, -1, 32767, -32768, 1234);
    const wav = encodeWav(input, 48_000);
    expect(wav.length).toBe(WAV_HEADER_BYTES + input.length * 2);
    const out = Array.from(
      { length: input.length },
      (_, i) => wav.readInt16LE(WAV_HEADER_BYTES + i * 2),
    );
    expect(out).toEqual([...input]);
  });
});

describe('selectForPruning', () => {
  const clip = (id: string, mb: number, at: number, flagged = false) =>
    ({ id, bytes: mb * 1024 * 1024, flagged, at });

  it('does nothing while under budget', () => {
    const r = selectForPruning([clip('a', 10, 1), clip('b', 10, 2)], 100 * 1024 * 1024);
    expect(r.remove).toEqual([]);
  });

  it('removes oldest first, and only as many as needed', () => {
    const clips = [clip('new', 30, 300), clip('old', 30, 100), clip('mid', 30, 200)];
    const r = selectForPruning(clips, 70 * 1024 * 1024);
    expect(r.remove).toEqual(['old']);
  });

  it('never removes a flagged clip, even when it is the oldest', () => {
    const clips = [clip('keep', 40, 100, true), clip('newer', 40, 200)];
    const r = selectForPruning(clips, 50 * 1024 * 1024);
    expect(r.remove).toEqual(['newer']);
    expect(r.remove).not.toContain('keep');
  });

  it('reports being stuck over budget rather than deleting flagged clips', () => {
    const clips = [clip('f1', 60, 100, true), clip('f2', 60, 200, true)];
    const r = selectForPruning(clips, 50 * 1024 * 1024);
    expect(r.remove).toEqual([]);
    expect(r.overBudgetByFlagged).toBe(true);
  });

  it('prunes down to the budget across several clips', () => {
    const clips = [
      clip('a', 25, 100), clip('b', 25, 200), clip('c', 25, 300), clip('d', 25, 400),
    ];
    const r = selectForPruning(clips, 50 * 1024 * 1024);
    expect(r.remove).toEqual(['a', 'b']);
    expect(r.overBudgetByFlagged).toBe(false);
  });
});
