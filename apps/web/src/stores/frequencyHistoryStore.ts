import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface FrequencyChangeEvent {
  id: string;
  channelId: string;
  channelName: string;
  deviceId: string;
  previousFrequencyHz: number;
  newFrequencyHz: number;
  timestamp: string; // ISO 8601
  source: 'TELEMETRY' | 'MANUAL'; // was it detected from hardware or set by user
}

const MAX_HISTORY = 500; // cap so localStorage doesn't grow unbounded

interface FrequencyHistoryState {
  events: FrequencyChangeEvent[];
  addEvent: (event: Omit<FrequencyChangeEvent, 'id'>) => void;
  clearAll: () => void;
  clearForChannel: (channelId: string) => void;
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const useFrequencyHistoryStore = create<FrequencyHistoryState>()(
  persist(
    (set) => ({
      events: [],

      addEvent: (event) =>
        set((state) => {
          const newEvent: FrequencyChangeEvent = { ...event, id: uid() };
          const events = [newEvent, ...state.events].slice(0, MAX_HISTORY);
          return { events };
        }),

      clearAll: () => set({ events: [] }),

      clearForChannel: (channelId) =>
        set((state) => ({
          events: state.events.filter((e) => e.channelId !== channelId),
        })),
    }),
    { name: 'rfdeck-freq-history' }
  )
);
