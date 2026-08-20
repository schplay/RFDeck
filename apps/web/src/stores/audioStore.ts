import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AudioState {
  // The MediaDeviceInfo.deviceId of the selected audio input interface
  selectedDeviceId: string | null;
  // channelId → 1-based audio input index on the selected interface
  channelAssignments: Record<string, number | null>;

  setSelectedDevice: (deviceId: string | null) => void;
  assignChannelToInput: (channelId: string, inputIndex: number | null) => void;
}

export const useAudioStore = create<AudioState>()(
  persist(
    (set) => ({
      selectedDeviceId: null,
      channelAssignments: {},

      setSelectedDevice: (deviceId) => set({ selectedDeviceId: deviceId }),

      assignChannelToInput: (channelId, inputIndex) =>
        set((state) => ({
          channelAssignments: { ...state.channelAssignments, [channelId]: inputIndex },
        })),
    }),
    { name: 'rfdeck-audio-config' }
  )
);
