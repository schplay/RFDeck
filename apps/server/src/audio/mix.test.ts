import { describe, it, expect } from 'vitest';
import { mixFrames, levelOf, FrameQueue } from './mix';

// The listen bus arithmetic. Small enough to be exact about.

describe('mixFrames', () => {
  it('passes one frame through unchanged', () => {
    const f = Int16Array.from([100, -200, 32767, -32768]);
    expect([...mixFrames([f], 4)]).toEqual([100, -200, 32767, -32768]);
  });

  it('attenuates by the number of members, so two full-scale channels cannot clip', () => {
    const a = Int16Array.from([32767, 32767]);
    const b = Int16Array.from([32767, -32767]);
    const out = mixFrames([a, b], 2);
    expect(out[0]).toBe(32767);   // (32767 + 32767) / 2
    expect(out[1]).toBe(0);       // (32767 − 32767) / 2
  });

  it('makes each of N channels exactly 1/N as loud as alone', () => {
    const f = Int16Array.from([1000]);
    expect(mixFrames([f, f, f, f], 1)[0]).toBe(1000);           // same signal ×4 / 4
    const silent = new Int16Array(1);
    expect(mixFrames([f, silent, silent, silent], 1)[0]).toBe(250);
  });

  it('treats a short member as silence beyond its end rather than stalling', () => {
    const full = Int16Array.from([400, 400, 400]);
    const short = Int16Array.from([400]);
    expect([...mixFrames([full, short], 3)]).toEqual([400, 200, 200]);
  });

  it('is silence with no members', () => {
    expect([...mixFrames([], 3)]).toEqual([0, 0, 0]);
  });
});

describe('levelOf', () => {
  it('reads full scale as 1', () => {
    const { peak, rms } = levelOf(Int16Array.from([32768 - 1, -32768]));
    expect(peak).toBeCloseTo(1, 3);
    expect(rms).toBeCloseTo(1, 3);
  });

  it('reads silence as 0', () => {
    expect(levelOf(new Int16Array(480))).toEqual({ peak: 0, rms: 0 });
  });

  it('gives a square wave equal peak and rms, and a lower rms for a spike', () => {
    const square = Int16Array.from([16384, -16384, 16384, -16384]);
    const sq = levelOf(square);
    expect(sq.peak).toBeCloseTo(sq.rms, 6);

    const spike = Int16Array.from([16384, 0, 0, 0]);
    const sp = levelOf(spike);
    expect(sp.peak).toBeCloseTo(0.5, 3);
    expect(sp.rms).toBeLessThan(sp.peak);
  });
});

describe('FrameQueue', () => {
  it('hands back frames in order', () => {
    const q = new FrameQueue();
    q.push(Int16Array.from([1]));
    q.push(Int16Array.from([2]));
    expect(q.shift()![0]).toBe(1);
    expect(q.shift()![0]).toBe(2);
    expect(q.shift()).toBeNull();
  });

  it('drops the oldest when a member runs ahead, so latency cannot grow', () => {
    const q = new FrameQueue(3);
    for (let i = 1; i <= 5; i++) q.push(Int16Array.from([i]));
    expect(q.depth).toBe(3);
    expect(q.shift()![0]).toBe(3);
  });
});
