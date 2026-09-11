// Alert severities, and whether one clears a threshold.
//
// Kept apart from delivery so the one rule every channel of notification
// shares — "is this loud enough to send" — is written once and tested once.

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

const RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export function isSeverity(v: unknown): v is Severity {
  return v === 'INFO' || v === 'WARNING' || v === 'CRITICAL';
}

/** True when an alert of `severity` should be sent to a target set to `min`. */
export function passesThreshold(severity: unknown, min: unknown): boolean {
  const s = isSeverity(severity) ? severity : 'INFO';
  const m = isSeverity(min) ? min : 'CRITICAL';
  return RANK[s] >= RANK[m];
}

/** Coerce anything into a valid threshold, defaulting to the quiet end. */
export function normaliseThreshold(v: unknown): Severity {
  return isSeverity(v) ? v : 'CRITICAL';
}
