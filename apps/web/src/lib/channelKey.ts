import { Channel } from '@rfdeck/shared-types';

// The stable identifier for a channel across sessions and power cycles.
//
// This is the channel id, and nothing else. The id is built server-side from
// the inventory row's uuid and the receiver slot: RFDeck owns the uuid and the
// slot is physical, so the id survives a DHCP reassignment, a rename of the
// inventory row, and a rename of the channel on the hardware.
//
// It used to be the channel NAME, because ids were built from "ip:port-rxN"
// and changed whenever DHCP moved a receiver. That worked around one problem
// by creating a worse one: the name belongs to the hardware, is not RFDeck's
// to depend on, and can be edited at the rack mid-show — so relabelling a
// channel silently detached its audio patch and orphaned its mic-check
// history, its detections and its place in the operator's card order.
//
// Kept as a function, rather than inlining `ch.id` everywhere, so there stays
// one place that defines what identifies a channel.
export function channelKey(ch: Pick<Channel, 'id'>): string {
  return ch.id;
}
