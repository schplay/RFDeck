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
