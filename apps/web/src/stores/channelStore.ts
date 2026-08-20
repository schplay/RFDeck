import { create } from 'zustand';
import { Channel } from '@rfdeck/shared-types';

interface ChannelState {
  channels: Channel[];
  /** channelId → epoch ms of the last telemetry received. Drives staleness
   *  detection: frozen readings that still look plausible are the dangerous
   *  failure during a show, so views need to tell "live" from "last known". */
  lastUpdate: Record<string, number>;
  setChannels: (channels: Channel[]) => void;
  updateChannel: (id: string, partial: Partial<Channel>) => void;
  removeChannelsForDevice: (ipPrefix: string) => void;
}

export const useChannelStore = create<ChannelState>((set) => ({
  channels: [],
  lastUpdate: {},

  setChannels: (channels) => set({ channels }),

  updateChannel: (id, partial) => set((state) => ({
    channels: state.channels.map(c => c.id === id ? { ...c, ...partial } : c),
    lastUpdate: { ...state.lastUpdate, [id]: Date.now() },
  })),

  removeChannelsForDevice: (ipPrefix) => set((state) => {
    const lastUpdate = { ...state.lastUpdate };
    for (const key of Object.keys(lastUpdate)) {
      if (key.startsWith(ipPrefix)) delete lastUpdate[key];
    }
    return {
      channels: state.channels.filter(c => !c.deviceId.startsWith(ipPrefix)),
      lastUpdate,
    };
  }),
}));
