import { describe, it, expect } from 'vitest';
import { DeviceManagerService } from './sennheiser/DeviceManagerService';

// What identifies a channel, and what must never be allowed to.
//
// Everything durable about a channel — the audio patch, mic-check ticks, a
// performer's mic assignment, detections, the event log, the operator's card
// order — is filed against its id. So the id has to be built only from things
// that cannot change underneath it: the inventory row's uuid, which RFDeck
// assigns and nothing else can touch, and the receiver slot, which is
// physical.
//
// It used to be built from the device address, which DHCP reassigns. The
// workaround for that was to key durable records on the channel NAME instead —
// and a name belongs to the hardware, is not RFDeck's, and can be edited at
// the rack in the middle of a show. Relabelling a channel silently detached
// its patch and orphaned its history.

// The composition rule, reached directly. The manager needs a socket server to
// construct and none of that is involved in deciding an identity.
function manager() {
  return new DeviceManagerService({ emit() {} } as any);
}

function idFor(m: DeviceManagerService, address: string, rowId: string, slot: number) {
  (m as any).deviceRowIds.set(address, rowId);
  return (m as any).stableChannelId(address, slot);
}

describe('a channel id', () => {
  it('is the inventory row and the receiver slot', () => {
    const m = manager();
    expect(idFor(m, '10.0.0.5:443', 'row-abc', 1)).toBe('row-abc:1');
    expect(idFor(m, '10.0.0.5:443', 'row-abc', 2)).toBe('row-abc:2');
  });

  it('does not change when the device changes address', () => {
    // The whole point. A receiver handed a new address by DHCP is the same
    // receiver, and its channels are the same channels.
    const m = manager();
    const before = idFor(m, '10.0.0.5:443', 'row-abc', 1);
    (m as any).deviceRowIds.delete('10.0.0.5:443');
    const after = idFor(m, '10.0.0.99:443', 'row-abc', 1);
    expect(after).toBe(before);
  });

  it('separates two receivers at the same slot', () => {
    const m = manager();
    expect(idFor(m, '10.0.0.5:443', 'row-abc', 1))
      .not.toBe(idFor(m, '10.0.0.6:443', 'row-def', 1));
  });

  it('is the same for a device whichever client is speaking to it', () => {
    // A Sennheiser device that falls back to the G3/G4 client is tracked under
    // an id with a "-legacy" suffix. That is an implementation detail of which
    // client holds the socket, not a different piece of hardware, and it must
    // not produce a second identity for the same physical channel.
    const m = manager();
    (m as any).deviceRowIds.set('10.0.0.5:443', 'row-abc');
    expect((m as any).stableChannelId('10.0.0.5:443-legacy', 1)).toBe('row-abc:1');
  });

  it('scopes a device prefix to that device alone', () => {
    const m = manager();
    (m as any).deviceRowIds.set('10.0.0.5:443', 'row-abc');
    const prefix = (m as any).channelIdPrefix('10.0.0.5:443');
    expect((m as any).stableChannelId('10.0.0.5:443', 3).startsWith(prefix)).toBe(true);
    expect('row-def:3'.startsWith(prefix)).toBe(false);
  });

  it('falls back to the address only when the row is unknown', () => {
    // A device tracked from something other than an inventory row. Not stable
    // across an address change, but it must still be distinct per channel
    // rather than collapsing every channel onto one key.
    const m = manager();
    const a = (m as any).stableChannelId('10.0.0.5:443', 1);
    const b = (m as any).stableChannelId('10.0.0.5:443', 2);
    expect(a).not.toBe(b);
  });
});
