import { describe, it, expect } from 'vitest';
import {
  addSample, estimate, survivesShow, BatterySample, BATTERY_WINDOW_MS,
} from './batteryEstimator';

const MIN = 60_000;
const t0 = 1_700_000_000_000;

// Build a history draining at a steady rate.
function drainingHistory(opts: {
  startPercent: number;
  perHour: number;
  minutes: number;
  stepMinutes?: number;
  /** Round readings to this step, as real packs do. */
  quantize?: number;
}): BatterySample[] {
  const { startPercent, perHour, minutes, stepMinutes = 1, quantize } = opts;
  const out: BatterySample[] = [];
  for (let m = 0; m <= minutes; m += stepMinutes) {
    const raw = startPercent - (perHour * m) / 60;
    out.push({
      t: t0 + m * MIN,
      percent: quantize ? Math.round(raw / quantize) * quantize : raw,
    });
  }
  return out;
}

describe('addSample', () => {
  it('drops samples older than the window', () => {
    const old: BatterySample = { t: t0, percent: 100 };
    const fresh: BatterySample = { t: t0 + BATTERY_WINDOW_MS + MIN, percent: 80 };
    expect(addSample([old], fresh)).toEqual([fresh]);
  });

  it('keeps samples inside the window', () => {
    const a: BatterySample = { t: t0, percent: 100 };
    const b: BatterySample = { t: t0 + 10 * MIN, percent: 95 };
    expect(addSample([a], b)).toHaveLength(2);
  });
});

describe('estimate — confidence gating', () => {
  it('returns null with too few samples', () => {
    // Two readings 20 seconds apart cannot support "6 hours remaining", and an
    // operator might act on it.
    expect(estimate([{ t: t0, percent: 100 }])).toBeNull();
    expect(estimate([{ t: t0, percent: 100 }, { t: t0 + 20_000, percent: 99 }])).toBeNull();
  });

  it('withholds a projection over too short a span', () => {
    const history = drainingHistory({ startPercent: 100, perHour: 10, minutes: 3 });
    const est = estimate(history);
    expect(est).not.toBeNull();
    expect(est!.confident).toBe(false);
    expect(est!.minutesRemaining).toBeNull();
  });

  it('withholds a projection when the pack has barely moved', () => {
    // Long window, but the reading has not visibly dropped yet.
    const history = drainingHistory({ startPercent: 100, perHour: 0.5, minutes: 30 });
    const est = estimate(history);
    expect(est!.confident).toBe(false);
    expect(est!.minutesRemaining).toBeNull();
  });

  it('becomes confident once there is real spread and real drop', () => {
    const history = drainingHistory({ startPercent: 100, perHour: 20, minutes: 30 });
    const est = estimate(history);
    expect(est!.confident).toBe(true);
    expect(est!.minutesRemaining).not.toBeNull();
  });
});

describe('estimate — accuracy', () => {
  it('recovers a known drain rate', () => {
    const history = drainingHistory({ startPercent: 100, perHour: 20, minutes: 30 });
    const est = estimate(history)!;
    expect(est.drainPerHour).toBeCloseTo(20, 1);
  });

  it('projects time to empty', () => {
    // Ends at 90%, draining 20%/hr → 4.5 hours ≈ 270 minutes.
    const history = drainingHistory({ startPercent: 100, perHour: 20, minutes: 30 });
    const est = estimate(history)!;
    expect(est.minutesRemaining!).toBeCloseTo(270, 0);
  });

  it('handles coarse, stepped readings', () => {
    // The real-world case: packs report in 5% steps, so consecutive samples are
    // identical and then jump. Differencing adjacent readings would give zero
    // or a spike; regression across the window recovers the trend.
    const history = drainingHistory({
      startPercent: 100, perHour: 20, minutes: 45, quantize: 5,
    });
    const est = estimate(history)!;
    expect(est.drainPerHour).toBeGreaterThan(15);
    expect(est.drainPerHour).toBeLessThan(25);
  });

  it('reports no projection for a charging pack', () => {
    const history = drainingHistory({ startPercent: 40, perHour: -30, minutes: 30 });
    const est = estimate(history)!;
    expect(est.drainPerHour).toBeLessThan(0);
    expect(est.minutesRemaining).toBeNull();
    expect(est.confident).toBe(false);
  });

  it('reports no projection for an idle pack', () => {
    const history = drainingHistory({ startPercent: 80, perHour: 0, minutes: 30 });
    const est = estimate(history)!;
    expect(est.minutesRemaining).toBeNull();
  });
});

describe('survivesShow', () => {
  const confident = drainingHistory({ startPercent: 100, perHour: 20, minutes: 30 });
  const marginal  = drainingHistory({ startPercent: 30, perHour: 20, minutes: 30 });

  it('says yes when the pack outlasts the show', () => {
    // ~270 minutes left, 120-minute show.
    expect(survivesShow(estimate(confident), 120)).toBe(true);
  });

  it('says no when it will not', () => {
    // ~60 minutes left, 120-minute show — this is the pack to swap.
    expect(survivesShow(estimate(marginal), 120)).toBe(false);
  });

  it('declines to guess without confidence', () => {
    const early = drainingHistory({ startPercent: 100, perHour: 20, minutes: 2 });
    expect(survivesShow(estimate(early), 120)).toBeNull();
    expect(survivesShow(null, 120)).toBeNull();
  });
});
