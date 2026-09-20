import { Channel } from '@rfdeck/shared-types';
import { useMemo } from 'react';
import { useChannelStore } from '../stores/channelStore';
import { useDeviceStore, InventoryDevice } from '../stores/deviceStore';

/**
 * A readable name for a channel that is not on the air.
 *
 * A saved assignment outlives the device that carried it: a receiver gets
 * powered down, or marked inactive for this show, and its channels stop
 * arriving from the server entirely. The assignment is still there, keyed on
 * the channel id — and the channel id is the inventory row's uuid and the
 * receiver slot, which is exactly the right thing to store and exactly the
 * wrong thing to put in front of a person. The mic and IEM selects were
 * showing rows like "f47ac10b-58cc-4372-a567-0e02b2c3d479:2 (offline)", which
 * an operator has no way to recognise as anybody's mic.
 *
 * The inventory row survives the device going away, so it can still say which
 * receiver and which slot. Falls back to the raw key only when even that is
 * gone — a device deleted from the inventory with a cast still pointing at it.
 */
export function describeChannelKey(
  key: string,
  channels: Channel[],
  inventory: InventoryDevice[],
): string {
  // On the air: the channel says what it is called.
  const live = channels.find(ch => ch.id === key);
  if (live) return live.name || `CH ${live.channelIndex}`;

  // Off the air: the inventory row still knows the receiver, and the id still
  // carries the slot. Both id shapes are handled — "<uuid>:<slot>" is current,
  // "<ip>:<port>-rx<slot>" is what rows added before stable ids carry.
  const stable = /^(.+):(\d+)$/.exec(key);
  const legacy = /^(.+)-rx(\d+)$/.exec(key);
  const [, owner, slot] = stable ?? legacy ?? [];

  if (owner) {
    const dev = inventory.find(d => d.id === owner)
             ?? inventory.find(d => `${d.ip}:${d.port}` === owner)
             ?? inventory.find(d => d.ip === owner.split(':')[0]);
    if (dev) return `${dev.name} CH ${slot}`;
  }

  return key;
}

/** `describeChannelKey` bound to the live stores. */
export function useChannelLabeller(): (key: string) => string {
  const channels = useChannelStore(s => s.channels);
  const inventory = useDeviceStore(s => s.inventory);
  return useMemo(
    () => (key: string) => describeChannelKey(key, channels, inventory),
    [channels, inventory],
  );
}
