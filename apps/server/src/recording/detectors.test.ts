import { describe, it, expect } from 'vitest';
import {
  frameFeatures, dbfs, ChannelDetector, shouldPromote,
  DEFAULT_DETECTOR_CONFIG, FrameFeatures,
} from './detectors';

// Driven with synthesised waveforms that stand in for the real thing: a tone
// for voiced programme, white noise for analog fuzz, zeros for a digital mute,
// a spike for a click. What matters as much as catching faults is NOT catching
// speech — an operator who sees one false detection during a show stops
// believing the next ten.

const RATE = 48_000;
const FRAME = 480; // 10 ms

function tone(n: number, freq: number, amp: number, phase = 0): Int16Array {
  return Int16Array.from({ length: n }, (_, i) =>
    Math.round(amp * Math.sin(2 * Math.PI * freq * ((i + phase) / RATE))));
}

// Deterministic pseudo-random noise, so a failure is always reproducible.
function noise(n: number, amp: number, seed = 1): Int16Array {
  let s = seed;
  return Int16Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return Math.round(((s / 0xffffffff) * 2 - 1) * amp);
  });
}

const silence = (n: number) => new Int16Array(n);

describe('frameFeatures', () => {
  it('separates noise from a tone by tonality, which is the whole basis of fuzz detection', () => {
    const t = frameFeatures(tone(FRAME, 220, 8000));
    const n = frameFeatures(noise(FRAME, 8000));
    // A 220 Hz tone at 48 kHz is heavily oversampled: adjacent samples are
    // nearly identical, so lag-1 autocorrelation is close to 1.
    expect(t.tonality).toBeGreaterThan(0.95);
    // White noise is uncorrelated sample to sample.
    expect(Math.abs(n.tonality)).toBeLessThan(0.2);
  });

  it('gives noise a far higher zero-crossing rate than a low tone', () => {
    expect(frameFeatures(noise(FRAME, 8000)).zcr)
      .toBeGreaterThan(frameFeatures(tone(FRAME, 220, 8000)).zcr * 10);
  });

  it('reports silence as silent, and calls it tonal rather than noisy', () => {
    const f = frameFeatures(silence(FRAME));
    expect(f.rms).toBe(0);
    expect(f.peak).toBe(0);
    // Undefined correlation must not read as noise, or every gap would be fuzz.
    expect(f.tonality).toBe(1);
  });

  it('measures RMS correctly for a known signal', () => {
    // A full-scale sine has RMS = amplitude / sqrt(2).
    const f = frameFeatures(tone(FRAME * 10, 1000, 10000));
    expect(f.rms).toBeGreaterThan(10000 / Math.SQRT2 * 0.95);
    expect(f.rms).toBeLessThan(10000 / Math.SQRT2 * 1.05);
  });

  it('spots an impulse through the second difference', () => {
    const clean = tone(FRAME, 440, 6000);
    const clicked = Int16Array.from(clean);
    clicked[200] = 30000;
    expect(frameFeatures(clicked).maxD2)
      .toBeGreaterThan(frameFeatures(clean).maxD2 * 10);
  });

  it('handles an empty frame without dividing by zero', () => {
    expect(frameFeatures(new Int16Array(0))).toMatchObject({ rms: 0, tonality: 1 });
  });
});

describe('dbfs', () => {
  it('maps full scale to 0 dB and silence to -Infinity', () => {
    expect(dbfs(32768)).toBeCloseTo(0, 5);
    expect(dbfs(0)).toBe(-Infinity);
    expect(dbfs(3277)).toBeCloseTo(-20, 0);
  });
});

// Feed a detector a run of identical frames, collecting whatever it emits.
function run(
  det: ChannelDetector,
  samples: Int16Array,
  frames: number,
  startMs = 0,
): ReturnType<ChannelDetector['push']>[] {
  const out: ReturnType<ChannelDetector['push']>[] = [];
  const f = frameFeatures(samples);
  for (let i = 0; i < frames; i++) {
    const e = det.push(f, startMs + i * 10);
    if (e) out.push(e);
  }
  return out;
}

describe('ChannelDetector — dropout', () => {
  it('fires when loud programme cuts abruptly to silence', () => {
    const det = new ChannelDetector();
    run(det, tone(FRAME, 300, 12000), 100);           // 1 s of programme
    const events = run(det, silence(FRAME), 20, 1000); // then a mute
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('AUDIO_DROPOUT');
    expect(events[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('does not fire on silence that was never preceded by programme', () => {
    // An idle channel is silent forever; that is not a dropout.
    const det = new ChannelDetector();
    expect(run(det, silence(FRAME), 200)).toEqual([]);
  });

  it('does not fire on a brief gap between words', () => {
    const det = new ChannelDetector();
    run(det, tone(FRAME, 300, 12000), 100);
    // 30 ms is shorter than minDropoutMs; ordinary speech is full of these.
    expect(run(det, silence(FRAME), 3, 1000)).toEqual([]);
  });

  it('does not fire when the level was already low — nothing was lost', () => {
    const det = new ChannelDetector();
    run(det, tone(FRAME, 300, 20), 100); // barely above the silence floor
    expect(run(det, silence(FRAME), 20, 1000)).toEqual([]);
  });

  it('reports one incident, not one per frame, while the mute continues', () => {
    const det = new ChannelDetector();
    run(det, tone(FRAME, 300, 12000), 100);
    const events = run(det, silence(FRAME), 200, 1000); // 2 s of silence
    expect(events.length).toBe(1);
  });
});

describe('ChannelDetector — noise', () => {
  it('fires on sustained broadband noise', () => {
    const det = new ChannelDetector();
    run(det, tone(FRAME, 300, 10000), 60);
    const events = run(det, noise(FRAME, 9000), 60, 600); // 600 ms of fuzz
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('AUDIO_NOISE');
    // Past sibilant length, so it stands without RF corroboration.
    expect(events[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('treats a short noise burst as a candidate needing RF, not a fault', () => {
    // 100 ms of broadband noise is a plausible /s/. Reported when the run
    // ends, because only then is its length known.
    const det = new ChannelDetector();
    run(det, tone(FRAME, 300, 10000), 60);
    expect(run(det, noise(FRAME, 9000), 10, 600)).toEqual([]);
    const events = run(det, tone(FRAME, 300, 10000), 5, 700);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('AUDIO_NOISE');
    expect(events[0]!.confidence).toBeLessThan(DEFAULT_DETECTOR_CONFIG.promoteWithoutRf);
  });

  it('ignores a burst too short to be anything', () => {
    // 20 ms — below the minimum, and far below a sibilant.
    const det = new ChannelDetector();
    run(det, tone(FRAME, 300, 10000), 60);
    run(det, noise(FRAME, 9000), 2, 600);
    expect(run(det, tone(FRAME, 300, 10000), 5, 620)).toEqual([]);
  });

  it('never fires on sustained voiced programme', () => {
    const det = new ChannelDetector();
    expect(run(det, tone(FRAME, 300, 12000), 500)).toEqual([]);
  });

  it('does not call quiet room tone a noise burst', () => {
    // Broadband but inaudible — below the level gate.
    const det = new ChannelDetector();
    expect(run(det, noise(FRAME, 12), 300)).toEqual([]);
  });
});

describe('ChannelDetector — click', () => {
  it('fires on an impulse against a settled baseline', () => {
    const det = new ChannelDetector();
    run(det, tone(FRAME, 440, 6000), 200); // establish what normal looks like

    const clicked = Int16Array.from(tone(FRAME, 440, 6000));
    clicked[100] = 32000;
    clicked[101] = -32000;
    const e = det.push(frameFeatures(clicked), 2000);
    expect(e?.kind).toBe('AUDIO_CLICK');
  });

  it('leaves a click below the promotion bar, since a plosive looks the same', () => {
    const det = new ChannelDetector();
    run(det, tone(FRAME, 440, 6000), 200);
    const clicked = Int16Array.from(tone(FRAME, 440, 6000));
    clicked[100] = 32000;
    const e = det.push(frameFeatures(clicked), 2000);
    expect(e!.confidence).toBeLessThan(DEFAULT_DETECTOR_CONFIG.promoteWithoutRf);
  });

  it('does not fire during the warm-up, before a baseline exists', () => {
    const det = new ChannelDetector();
    const clicked = Int16Array.from(tone(FRAME, 440, 6000));
    clicked[100] = 32000;
    expect(det.push(frameFeatures(clicked), 0)).toBeNull();
  });

  it('does not call the end of a sung phrase a dropout', () => {
    // Amplitude fading smoothly to nothing over ~200 ms, then silence. This
    // is what a phrase ending looks like, and comparing against a peak from
    // seconds earlier used to report it as a mute.
    const det = new ChannelDetector();
    const events: unknown[] = [];
    let ms = 0;
    for (let i = 0; i < 400; i++) {
      const amp = 4000 + 4000 * Math.sin(i / 20);
      const e = det.push(frameFeatures(tone(FRAME, 300, amp, i * FRAME)), ms);
      if (e) events.push(e);
      ms += 10;
    }
    expect(events).toEqual([]);
  });

  it('does not treat ordinary programme as a stream of clicks', () => {
    const det = new ChannelDetector();
    // Varying level and pitch, as speech does.
    let ms = 0;
    const events: unknown[] = [];
    for (let i = 0; i < 400; i++) {
      const amp = 4000 + 4000 * Math.sin(i / 20);
      const e = det.push(frameFeatures(tone(FRAME, 200 + (i % 50) * 4, amp, i * FRAME)), ms);
      if (e) events.push(e);
      ms += 10;
    }
    expect(events).toEqual([]);
  });
});

describe('shouldPromote', () => {
  const ev = (confidence: number): any => ({
    kind: 'AUDIO_NOISE', atMs: 0, durationMs: 100, confidence, message: '',
  });

  it('promotes strong audio evidence without needing RF', () => {
    expect(shouldPromote(ev(0.85), false)).toBe(true);
  });

  it('holds an ambiguous candidate back unless RF agrees', () => {
    expect(shouldPromote(ev(0.5), false)).toBe(false);
    expect(shouldPromote(ev(0.5), true)).toBe(true);
  });
});
