import { create } from 'zustand';
import { Channel } from '@rfdeck/shared-types';

interface ChannelState {
  channels: Channel[];
  setChannels: (channels: Channel[]) => void;
  updateChannel: (id: string, partial: Partial<Channel>) => void;
}

export const useChannelStore = create<ChannelState>((set) => ({
  channels: [],
  setChannels: (channels) => set({ channels }),
  updateChannel: (id, partial) => set((state) => ({
    channels: state.channels.map(c => c.id === id ? { ...c, ...partial } : c)
  }))
}));
