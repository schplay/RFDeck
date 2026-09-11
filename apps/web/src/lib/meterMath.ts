// The arithmetic behind a meter, kept apart from React so it is plain to read
// and plain to reason about.
//
// Three things a meter does beyond drawing a number:
//
//   • decide what colour a level is, from thresholds that depend on which way
//     is bad — RF is bad when low, audio is bad when high;
//   • move toward a new reading at a chosen speed (ballistics), because a bar
//     that snaps to every telemetry frame is unreadable and one that drifts is
//     late;
//   • remember the highest recent reading (peak hold), because a transient
//     dropout or an audio spike is over before the eye gets to the bar.
//
// A note on "peak vs RMS". The audio level RFDeck meters is the one the
// receiver reports over its control protocol — a number, not the audio. There
// is nothing to take the RMS of. So the choice offered is ballistics: a
// peak-reading meter (fast attack, slow release) or an averaging one. Metering
// from the audio itself, where RMS means something, arrives with the listen
// bus (C.4), which is the first point at which audio reaches the browser.

export type MeterKind = 'rf' | 'af';
export type Tone = 'good' | 'warn' | 'crit';
export type Ballistics = 'instant' | 'fast' | 'averaged';

export interface Thresholds {
  /** The level at which the reading becomes a warning. */
  warn: number;
  /** The level at which it becomes critical. */
  crit: number;
}

/**
 * Which colour a level is.
 *
 * `lowIsBad` decides the direction: for RF, anything below `crit` is critical
 * and anything below `warn` is a warning; for audio it is the reverse, since
 * what you fear is the top of the scale.
 */
export function toneFor(level: number, t: Thresholds, lowIsBad: boolean): Tone {
  if (lowIsBad) {
    if (level < t.crit) return 'crit';
    if (level < t.warn) return 'warn';
    return 'good';
  }
  if (level >= t.crit) return 'crit';
  if (level >= t.warn) return 'warn';
  return 'good';
}

export const LOW_IS_BAD: Record<MeterKind, boolean> = { rf: true, af: false };

/**
 * Time constants, in milliseconds, for moving toward a new reading.
 *
 * Attack is how fast the bar rises to a higher reading; release how fast it
 * falls to a lower one. "Fast" is the peak-reading shape — rises at once,
 * falls slowly enough to be seen. "Averaged" moves both ways at a VU-like
 * pace. "Instant" is no ballistics at all.
 */
export const BALLISTICS: Record<Ballistics, { attackMs: number; releaseMs: number }> = {
  instant:  { attackMs: 0,   releaseMs: 0 },
  fast:     { attackMs: 0,   releaseMs: 600 },
  averaged: { attackMs: 300, releaseMs: 300 },
};

/**
 * Move `current` toward `target` given `dtMs` elapsed, with a time constant of
 * `tauMs`. First-order: the gap closes by a factor of e every tau.
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (tauMs <= 0 || dtMs <= 0) return target;
  const k = 1 - Math.exp(-dtMs / tauMs);
  return current + (target - current) * k;
}

export interface MeterState {
  /** What the bar shows. */
  value: number;
  /** The highest reading being held, or the value itself once it has fallen. */
  peak: number;
  /** When the peak was last raised, epoch ms. */
  peakAt: number;
  /** When the state was last advanced, epoch ms. */
  at: number;
}

export function initialMeterState(now: number, value = 0): MeterState {
  return { value, peak: value, peakAt: now, at: now };
}

/**
 * Advance a meter to time `now`, optionally with a new reading.
 *
 * Peak hold: the peak sits at the highest reading for `holdMs`, then falls at
 * the release rate to meet the bar. Without hold it simply tracks the bar.
 */
export function stepMeter(
  s: MeterState,
  now: number,
  reading: number | null,
  ballistics: Ballistics,
  peakHold: boolean,
  holdMs: number,
): MeterState {
  const { attackMs, releaseMs } = BALLISTICS[ballistics];
  const dt = Math.max(0, now - s.at);
  const target = reading ?? s.value;

  const value = target >= s.value
    ? approach(s.value, target, dt, attackMs)
    : approach(s.value, target, dt, releaseMs);

  let peak = s.peak;
  let peakAt = s.peakAt;
  if (!peakHold) {
    peak = value;
    peakAt = now;
  } else if (value >= peak) {
    peak = value;
    peakAt = now;
  } else if (now - peakAt > holdMs) {
    // Hold expired: fall toward the bar at the release rate, never below it.
    peak = Math.max(value, approach(peak, value, dt, releaseMs || 1));
  }

  return { value, peak, peakAt, at: now };
}

/**
 * Colour each of `segments` segments for a level and a peak.
 *
 * A segment is coloured for the level it *represents*, not for whether the
 * bar happens to reach it — so the top of an audio meter is always red when
 * lit, and the bottom of an RF meter is always red when that is all that is
 * lit. The peak segment is marked so the hold is visible as a single tick.
 */
export function segmentsFor(
  value: number,
  peak: number,
  segments: number,
  t: Thresholds,
  lowIsBad: boolean,
): Array<{ lit: boolean; tone: Tone; peak: boolean }> {
  const litCount = Math.round((Math.max(0, Math.min(100, value)) / 100) * segments);
  const peakIndex = Math.min(segments - 1, Math.round((Math.max(0, Math.min(100, peak)) / 100) * segments) - 1);
  return Array.from({ length: segments }, (_, i) => {
    const represents = ((i + 0.5) / segments) * 100;
    return {
      lit: i < litCount,
      tone: toneFor(represents, t, lowIsBad),
      peak: peak > value && i === peakIndex && i >= litCount,
    };
  });
}
