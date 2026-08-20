import { Channel } from '@rfdeck/shared-types';

// The stable identifier for a channel across sessions and power cycles.
//
// Channel ids are built from "ip:port-rxN", so they change whenever DHCP hands
// a receiver a new address. Anything that has to survive that — saved show
// records, mic-check ticks, player assignments, custom card ordering — must key
// on the channel NAME, which the operator sets on the hardware itself.
//
// Falls back to the id for an unnamed channel: not stable across an IP change,
// but the alternative is collapsing every unnamed channel into one key.
export function channelKey(ch: Pick<Channel, 'id' | 'name'>): string {
  return ch.name?.trim() || ch.id;
}
