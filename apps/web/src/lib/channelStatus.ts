import { Channel } from '@rfdeck/shared-types';

// What one word to say about a channel, and what colour to say it in.
//
// Lifted out of the Micboard so the dense grid and the wall display give the
// same answer for the same channel. Two views that disagree about whether a
// channel is a problem are worse than one view. Every view that shows a
// channel's state — cards, list, dense grid, Micboard, Backstage, stage plot —
// asks this function rather than deciding for itself.
//
// Tones:
//   good — on air and nothing to look at. Views draw this quietly: a rig
//          that is fine should not be a wall of green.
//   warn — needs attention soon (low RF, low battery).
//   crit — needs attention now (dropout, battery nearly flat, offline).
//   idle — deliberately silent (muted at the receiver or the transmitter).
//          A state, not a problem, so it is gray rather than amber.

export type StatusTone = 'good' | 'warn' | 'crit' | 'idle';

/** Battery thresholds, in percent. The same numbers the Battery page flags at. */
export const BATT_LOW = 20;
export const BATT_CRIT = 5;

export function batteryTone(pct: number | undefined | null): StatusTone {
  if (pct == null) return 'good';
  if (pct <= BATT_CRIT) return 'crit';
  if (pct <= BATT_LOW) return 'warn';
  return 'good';
}

export function channelStatus(ch: Channel, online: boolean, stale: boolean): {
  label: string; tone: StatusTone;
} {
  if (!online) return { label: 'OFFLINE', tone: 'crit' };
  if (stale) return { label: 'NO DATA', tone: 'crit' };
  if (ch.status === 'CRITICAL') return { label: 'DROPOUT', tone: 'crit' };
  const batt = batteryTone(ch.batteryPercent);
  if (batt === 'crit') return { label: 'BATT CRITICAL', tone: 'crit' };
  if (ch.isMuted) return { label: 'MUTED', tone: 'idle' };
  // A performer's own mute switch is a state, not a problem.
  if (ch.isTxMuted) return { label: 'TX MUTED', tone: 'idle' };
  if (ch.status === 'WARNING') return { label: 'LOW RF', tone: 'warn' };
  if (batt === 'warn') return { label: 'LOW BATT', tone: 'warn' };
  return { label: 'ON AIR', tone: 'good' };
}

/**
 * Where a channel lives, in the words an operator uses: "Vocal rack · Ch 3".
 * Falls back to the address only when the receiver is not in the inventory.
 */
export function channelPlace(ch: Channel, deviceName?: string | null): string {
  const where = deviceName || ch.deviceId.split(':')[0];
  return `${where} · Ch ${ch.channelIndex}`;
}
