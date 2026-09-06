import { useMemo } from 'react';
import { Channel } from '@rfdeck/shared-types';
import { useChannelStore } from '../stores/channelStore';
import { useDeviceStore } from '../stores/deviceStore';

// Channels belonging to devices the operator has marked inactive are hidden
// everywhere channels are shown (dashboard, backstage, mic check). An inactive
// device is intentionally powered off, so its absence is not a fault condition.
//
// Channel ids are prefixed with the device's "ip:port", so we match on the IP.
export function useActiveChannels(): Channel[] {
  const channels = useChannelStore((s) => s.channels);
  const inventory = useDeviceStore((s) => s.inventory);

  return useMemo(() => {
    const inactiveIps = new Set(
      inventory.filter((d) => d.active === false).map((d) => d.ip)
    );
    if (inactiveIps.size === 0) return channels;
    return channels.filter((ch) => !inactiveIps.has(ch.deviceId.split(':')[0]));
  }, [channels, inventory]);
}

/**
 * Active channels split by what the device is for.
 *
 * A receiver carries a microphone; an IEM transmitter carries a monitor feed.
 * They are both channels, but they are not interchangeable: a soundcheck is
 * about mics, and putting IEMs in that list gives the operator rows to tick
 * that no one is speaking into.
 *
 * The channel says which it is. This used to be worked out here by matching
 * channel ids against inventory IPs, which meant every client reimplementing
 * the rule and the *server* — where the RF dropout alerting actually lives —
 * never knowing at all. An IEM has no RF to receive, so it read as a channel
 * permanently at 0% and armed a dropout alert on a transmitter that was
 * working perfectly.
 */
/**
 * Order channels the way a person reading a list expects.
 *
 * By name, comparing embedded numbers as numbers, so "Vocal 2" comes before
 * "Vocal 10" rather than after it. Channels with no name of their own fall to
 * the end, ordered by receiver and slot so they are at least stable.
 *
 * Worth doing centrally: the mic check listed channels in whatever order
 * telemetry happened to arrive in, which changes on every restart and every
 * reconnect. Working down a soundcheck list under time pressure is hard enough
 * without the list being in a different order than it was last night.
 */
export function compareChannels(a: Channel, b: Channel): number {
  const an = (a.name ?? '').trim();
  const bn = (b.name ?? '').trim();
  if (an && bn) {
    const byName = an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
    if (byName !== 0) return byName;
  } else if (an !== bn) {
    return an ? -1 : 1;   // named channels first
  }
  const byDevice = a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true });
  return byDevice !== 0 ? byDevice : a.channelIndex - b.channelIndex;
}

export function useChannelsByRole(): { mics: Channel[]; iems: Channel[] } {
  const channels = useActiveChannels();

  return useMemo(() => {
    const mics: Channel[] = [];
    const iems: Channel[] = [];
    for (const ch of channels) {
      // Anything not explicitly an IEM counts as a mic: a soundcheck missing a
      // channel is worse than one listing an extra.
      (ch.role === 'iem' ? iems : mics).push(ch);
    }
    mics.sort(compareChannels);
    iems.sort(compareChannels);
    return { mics, iems };
  }, [channels]);
}
