// Battery runtime estimation.
//
// The useful question during a show is not "what percent is pack 7" but "will
// pack 7 last the act". That needs a drain rate, which needs history.
//
// Two properties of real transmitter batteries shape this:
//
//   Readings are coarse and stepped. Many packs report in 5% or 10% jumps, so
//   consecutive samples are usually identical and then move by a whole step.
//   Differencing adjacent samples produces either zero or a spike; neither is a
//   drain rate. Least-squares regression over a window handles it properly.
//
//   A freshly fitted pack has no useful history. Reporting "6 hours remaining"
//   from two samples taken 20 seconds apart is worse than reporting nothing,
//   because an operator may act on it. We return null until the window holds
//   enough spread to mean something.

export interface BatterySample {
  /** Epoch ms. */
  t: number;
  /** 0–100. */
  percent: number;
}

export interface BatteryEstimate {
  /** Percent per hour, positive while draining. */
  drainPerHour: number;
  /** Minutes until empty, or null when not yet confident. */
  minutesRemaining: number | null;
  /** Whether the estimate is trustworthy enough to display. */
  confident: boolean;
}

// Keep roughly an hour of history per channel.
export const BATTERY_WINDOW_MS = 60 * 60 * 1000;
// Below this spread the regression is noise, not a trend.
const MIN_SPAN_MS = 5 * 60 * 1000;
const MIN_SAMPLES = 4;
// A pack that has not visibly moved yet cannot be projected.
const MIN_OBSERVED_DROP = 2;

export function addSample(
  history: BatterySample[],
  sample: BatterySample,
  windowMs = BATTERY_WINDOW_MS,
): BatterySample[] {
  const next = [...history, sample];
  const cutoff = sample.t - windowMs;
  return next.filter(s => s.t >= cutoff);
}

// Least-squares slope of percent against time. Returns percent-per-hour, with
// the sign flipped so a draining pack reports a positive drain.
function drainPerHour(history: BatterySample[]): number | null {
  const n = history.length;
  if (n < 2) return null;

  const meanT = history.reduce((sum, s) => sum + s.t, 0) / n;
  const meanP = history.reduce((sum, s) => sum + s.percent, 0) / n;

  let num = 0;
  let den = 0;
  for (const s of history) {
    const dt = s.t - meanT;
    num += dt * (s.percent - meanP);
    den += dt * dt;
  }
  if (den === 0) return null;

  const perMs = num / den;          // percent per millisecond, negative while draining
  return -perMs * 3_600_000;        // percent per hour, positive while draining
}

export function estimate(history: BatterySample[]): BatteryEstimate | null {
  if (history.length < MIN_SAMPLES) return null;

  const span = history[history.length - 1].t - history[0].t;
  const observedDrop = Math.max(...history.map(s => s.percent)) -
                       history[history.length - 1].percent;

  const rate = drainPerHour(history);
  if (rate === null) return null;

  const current = history[history.length - 1].percent;

  // Charging, idle, or too early to tell. Report the rate but no projection —
  // a negative or zero drain has no meaningful time-to-empty.
  if (rate <= 0) {
    return { drainPerHour: rate, minutesRemaining: null, confident: false };
  }

  const confident =
    span >= MIN_SPAN_MS &&
    observedDrop >= MIN_OBSERVED_DROP &&
    history.length >= MIN_SAMPLES;

  return {
    drainPerHour: rate,
    minutesRemaining: confident ? Math.max(0, (current / rate) * 60) : null,
    confident,
  };
}

// Will this pack last the rest of the show?
// `showMinutesRemaining` comes from the operator's own expected running time.
export function survivesShow(
  est: BatteryEstimate | null,
  showMinutesRemaining: number,
): boolean | null {
  if (!est || !est.confident || est.minutesRemaining === null) return null;
  return est.minutesRemaining >= showMinutesRemaining;
}
