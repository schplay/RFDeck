import { create } from 'zustand';

export type RfEventType = 'DROPOUT' | 'RECOVERY' | 'WEAK_SIGNAL';

export interface RfEvent {
  id: string;
  type: RfEventType;
  channelId: string;
  channelName: string;
  deviceId: string;
  rfLevelA: number;
  rfLevelB: number;
  timestamp: string;
}

const MAX_EVENTS = 500;

// RF events are detected on the SERVER and pushed here — this store is a
// passive receiver.
//
// It used to derive dropouts locally from telemetry, which broke as soon as a
// second client existed: each browser kept its own divergent log, a client that
// was closed missed events entirely, and no log was authoritative enough to
// build a show report from. Detection now lives in DeviceManagerService, which
// also owns the confirmation window and hysteresis thresholds.
//
// Deliberately not persisted: the server replays recent events on connect, so
// a local copy could only ever conflict with it.

interface RfEventState {
  events: RfEvent[];
  addEvent: (event: RfEvent) => void;
  clearAll: () => void;
  clearForChannel: (channelId: string) => void;
}

export const useRfEventStore = create<RfEventState>()((set) => ({
  events: [],

  addEvent: (event) =>
    set((state) => {
      // The server replays on reconnect, so ignore anything already held.
      if (state.events.some((e) => e.id === event.id)) return state;
      return { events: [event, ...state.events].slice(0, MAX_EVENTS) };
    }),

  clearAll: () => set({ events: [] }),

  clearForChannel: (channelId) =>
    set((state) => ({ events: state.events.filter((e) => e.channelId !== channelId) })),
}));
