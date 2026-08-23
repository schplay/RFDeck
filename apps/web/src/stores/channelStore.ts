import { create } from 'zustand';
import { Channel } from '@rfdeck/shared-types';

export interface HeartbeatPayload {
  /** Server clock when the snapshot was taken. */
  at: number;
  /** deviceId → server clock of last contact, for devices currently online. */
  devices: Record<string, number>;
}

interface ChannelState {
  channels: Channel[];
  /** channelId → epoch ms of the last telemetry received. Kept as a fallback
   *  for devices that have not yet appeared in a heartbeat. */
  lastUpdate: Record<string, number>;
  /** deviceId → epoch ms (this client's clock) of last contact with the
   *  device, per the server's heartbeat. This — not telemetry recency — is what
   *  decides staleness: telemetry arrives only when a value changes, so a mic
   *  that is on but silent sends nothing, and that silence is not a fault. */
  deviceSeen: Record<string, number>;
  /** When the last heartbeat arrived, on this client's clock. Null until one has. */
  heartbeatAt: number | null;
  setChannels: (channels: Channel[]) => void;
  updateChannel: (id: string, partial: Partial<Channel>) => void;
  removeChannelsForDevice: (ipPrefix: string) => void;
  applyHeartbeat: (payload: HeartbeatPayload) => void;
}

export const useChannelStore = create<ChannelState>((set) => ({
  channels: [],
  lastUpdate: {},
  deviceSeen: {},
  heartbeatAt: null,

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
    const deviceSeen = { ...state.deviceSeen };
    for (const key of Object.keys(deviceSeen)) {
      if (key.startsWith(ipPrefix)) delete deviceSeen[key];
    }
    return {
      channels: state.channels.filter(c => !c.deviceId.startsWith(ipPrefix)),
      lastUpdate,
      deviceSeen,
    };
  }),

  applyHeartbeat: ({ at, devices }) => {
    // Translate server timestamps onto this client's clock using the age of
    // each entry relative to the snapshot, so two machines that disagree on
    // the time of day still agree on how long ago contact happened.
    const received = Date.now();
    const deviceSeen: Record<string, number> = {};
    for (const [deviceId, seen] of Object.entries(devices)) {
      deviceSeen[deviceId] = received - Math.max(0, at - seen);
    }
    set({ deviceSeen, heartbeatAt: received });
  },
}));
