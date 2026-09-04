// RF dropout / recovery state machine.
//
// Extracted from DeviceManagerService so the decision logic can be tested
// without a socket, a database, or hardware. This logic is subtle, has already
// regressed once, and is expensive to verify by hand against real receivers.
//
// Two mechanisms work together:
//
//   Hysteresis — fall below DROPOUT to enter a dropout, rise above RECOVERY to
//   leave it. The gap keeps a signal hovering at the boundary from oscillating.
//
//   Confirmation window — a dropout is only real once the signal STAYS low for
//   confirmMs. EW-DX diversity antenna switching drops to 0% and back within a
//   second while audio is perfectly fine; without the window that produced a
//   dropout/recovery pair every second and buried real faults.

export type RfState = 'OK' | 'DROPOUT';

export interface RfThresholds {
  /** Below this, the signal is a dropout candidate. */
  dropout: number;
  /** At or above this, a channel in dropout is considered recovered. */
  recovery: number;
  /** How long the signal must stay low before a dropout is confirmed. */
  confirmMs: number;
}

export const DEFAULT_RF_THRESHOLDS: RfThresholds = {
  dropout: 25,
  recovery: 45,
  confirmMs: 3_000,
};

export interface RfSample {
  rfLevelA: number;
  rfLevelB: number;
  isMuted: boolean;
  /**
   * What the channel is for. An IEM transmitter has no RF to receive, so its
   * levels are 0 for a reason that is not a fault.
   *
   * Optional and defaulting to a microphone, so every existing caller keeps
   * its behaviour.
   */
  role?: 'mic' | 'iem';
}

/** What the caller should do as a result of this sample. */
export type RfAction =
  | { kind: 'none' }
  /** Start (or keep) a confirmation timer for confirmMs. */
  | { kind: 'arm' }
  /** Cancel any pending confirmation — the signal came back in time. */
  | { kind: 'disarm' }
  /** Confirmed recovery; emit a RECOVERY event. */
  | { kind: 'recovered' };

// Diversity receivers report two antennas; the channel is only in trouble when
// BOTH are weak, so evaluate the stronger one.
export function signalLevel(sample: RfSample): number {
  return Math.max(sample.rfLevelA, sample.rfLevelB);
}

// Decide what to do with a fresh telemetry sample. Pure: no timers, no I/O.
export function evaluateSample(
  state: RfState,
  sample: RfSample,
  thresholds: RfThresholds = DEFAULT_RF_THRESHOLDS,
  hasPendingConfirmation = false,
): RfAction {
  // An IEM transmitter receives nothing, so it reports no RF and reads as 0 on
  // both antennas. Run through the rest of this and it arms a dropout, waits
  // out the confirmation window, confirms, and alerts — on a transmitter that
  // is working perfectly, every time, forever.
  //
  // Disarm rather than none: a channel reclassified as an IEM while a
  // confirmation was already pending must not have that timer fire.
  if (sample.role === 'iem') {
    return hasPendingConfirmation ? { kind: 'disarm' } : { kind: 'none' };
  }

  const level = signalLevel(sample);

  if (state === 'OK') {
    // A muted channel legitimately reads low — that is an operator action, not
    // a fault, and must never raise a dropout.
    if (level < thresholds.dropout && !sample.isMuted) {
      return hasPendingConfirmation ? { kind: 'none' } : { kind: 'arm' };
    }
    return hasPendingConfirmation ? { kind: 'disarm' } : { kind: 'none' };
  }

  // state === 'DROPOUT'
  if (level >= thresholds.recovery) return { kind: 'recovered' };
  return { kind: 'none' };
}

// Called when a confirmation timer fires: is this still a dropout, or did the
// signal recover while we were waiting?
export function confirmDropout(
  sample: RfSample | undefined,
  thresholds: RfThresholds = DEFAULT_RF_THRESHOLDS,
): boolean {
  if (!sample) return false;
  if (sample.isMuted) return false;
  return signalLevel(sample) < thresholds.dropout;
}
