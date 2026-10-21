// The record of carriers moving.
//
// Kept on the server because RFDeck serves several screens at once and runs
// when none is open: a history held in each browser saw only what happened
// while that browser was watching, and two operators could look at two
// different accounts of the same show.
//
// Each change is stored as an Event row, so it also lands in the show report,
// and says who moved the carrier: RFDeck (a retune sent from the app or a
// coordination plan) or the receiver itself (someone at the hardware, or
// another program).

/** Event types for a carrier moving. */
export const FREQUENCY_SET = 'FREQUENCY_SET';        // retuned by RFDeck
export const FREQUENCY_CHANGE = 'FREQUENCY_CHANGE';  // changed at the receiver
export const FREQUENCY_EVENT_TYPES = [FREQUENCY_SET, FREQUENCY_CHANGE] as const;

/**
 * How long after RFDeck sends a retune the matching telemetry still counts as
 * RFDeck's doing. Receivers confirm within a second or two; a minute leaves
 * room for a slow one without claiming a change someone made much later.
 */
export const RETUNE_WINDOW_MS = 60_000;

export interface PendingRetune {
  toKHz: number;
  at: number;
}

/** Whether a carrier landing on `toKHz` now is the retune RFDeck sent. */
export function isRfdeckRetune(pending: PendingRetune | undefined, toKHz: number, now: number): boolean {
  if (!pending) return false;
  if (now - pending.at > RETUNE_WINDOW_MS) return false;
  // Receivers step in kHz; one either side absorbs rounding from Hz.
  return Math.abs(pending.toKHz - toKHz) <= 1;
}

const mhz = (kHz: number) => (kHz / 1000).toFixed(3);

/** The line the event log and the show report print for the change. */
export function frequencyChangeMessage(byRfdeck: boolean, fromKHz: number, toKHz: number): string {
  return byRfdeck
    ? `Retuned by RFDeck: ${mhz(fromKHz)} → ${mhz(toKHz)} MHz`
    : `Frequency changed at the receiver: ${mhz(fromKHz)} → ${mhz(toKHz)} MHz`;
}
