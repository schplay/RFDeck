// The battery levels an operator has chosen to be warned at.
//
// Saved in Settings and applied everywhere a pack is judged: the server's low
// and critical alerts, and every view that colors a battery. A pack is "low" at
// or below warningPct and "critical" at or below criticalPct.

export interface BatteryThresholds {
  warningPct: number;
  criticalPct: number;
}

/** The schema's defaults, used until the saved values are read. */
export const DEFAULT_BATTERY_THRESHOLDS: BatteryThresholds = { warningPct: 20, criticalPct: 5 };

function whole(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Make a pair of thresholds usable: whole percentages, critical below warning.
 *
 * A value that is missing or not a number keeps the current one. The pair is
 * clamped rather than refused, because a critical level at or above the
 * warning level would make the low-battery warning impossible to reach.
 */
export function normalizeBatteryThresholds(
  warning: unknown,
  critical: unknown,
  current: BatteryThresholds = DEFAULT_BATTERY_THRESHOLDS,
): BatteryThresholds {
  const criticalPct = Math.min(98, Math.max(0, whole(critical) ?? current.criticalPct));
  const warningPct = Math.min(100, Math.max(criticalPct + 1, whole(warning) ?? current.warningPct));
  return { warningPct, criticalPct };
}

/**
 * One battery reading's effect on the low-battery alerts.
 *
 * A threshold crossing must hold for two consecutive samples: transmitters
 * report garbage while re-syncing, and one bad sample raised a CRITICAL alert
 * on a full pack in a live show. `pending` is the first low reading, held
 * until the next one confirms it.
 */
export function batteryAlertStep(
  oldPct: number,
  newPct: number,
  pending: number | undefined,
  t: BatteryThresholds,
): { pending: number | undefined; alert: 'low' | 'critical' | null } {
  if (newPct > t.warningPct) return { pending: undefined, alert: null };

  if (pending !== undefined && newPct <= pending) {
    // Second consecutive low reading: now it is real.
    return { pending: undefined, alert: newPct <= t.criticalPct ? 'critical' : 'low' };
  }

  const crossedLow = oldPct > t.warningPct && newPct > t.criticalPct;
  const crossedCritical = oldPct > t.criticalPct && newPct <= t.criticalPct;
  return { pending: crossedLow || crossedCritical ? newPct : pending, alert: null };
}
