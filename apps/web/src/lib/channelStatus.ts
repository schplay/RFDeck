import { Channel } from '@rfdeck/shared-types';

// What one word to say about a channel, and what colour to say it in.
//
// Lifted out of the Micboard so the dense grid and the wall display give the
// same answer for the same channel. Two views that disagree about whether a
// channel is a problem are worse than one view.

export type StatusTone = 'good' | 'warn' | 'crit' | 'idle';

export function channelStatus(ch: Channel, online: boolean, stale: boolean): {
  label: string; tone: StatusTone;
} {
  if (!online) return { label: 'OFFLINE', tone: 'crit' };
  if (stale) return { label: 'NO DATA', tone: 'crit' };
  if (ch.isMuted) return { label: 'MUTED', tone: 'warn' };
  // A performer's own mute switch is a state, not a problem.
  if (ch.isTxMuted) return { label: 'TX MUTED', tone: 'idle' };
  if (ch.status === 'CRITICAL') return { label: 'DROPOUT', tone: 'crit' };
  if (ch.status === 'WARNING') return { label: 'LOW RF', tone: 'warn' };
  return { label: 'ON AIR', tone: 'good' };
}
