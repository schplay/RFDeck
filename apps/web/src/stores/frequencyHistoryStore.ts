import { create } from 'zustand';
import { apiFetch } from '../lib/api';

// Every time a carrier moved, as the server recorded it.
//
// The server keeps this history, not the browser: it records while no screen
// is open, and every screen shows the same account. This store loads the
// history when the socket connects and adds each change as it is broadcast.

export interface FrequencyChangeEvent {
  id: string;
  timestamp: string; // ISO 8601
  /** FREQUENCY_SET: retuned by RFDeck. FREQUENCY_CHANGE: changed at the receiver. */
  type: 'FREQUENCY_SET' | 'FREQUENCY_CHANGE';
  channelKey: string | null;
  /** What the channel was called at the time. */
  channelName: string | null;
  deviceId: string | null;
  fromKHz: number;
  toKHz: number;
}

/** As much history as the server hands out in one request. */
const LOAD_LIMIT = 1000;

interface FrequencyHistoryState {
  events: FrequencyChangeEvent[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (event: FrequencyChangeEvent) => void;
}

export const useFrequencyHistoryStore = create<FrequencyHistoryState>()((set) => ({
  events: [],
  loaded: false,

  load: async () => {
    try {
      const res = await apiFetch<{ events: FrequencyChangeEvent[] }>(
        `/events?type=FREQUENCY_SET,FREQUENCY_CHANGE&limit=${LOAD_LIMIT}`);
      set({ events: res.events.filter(e => e.fromKHz != null && e.toKHz != null), loaded: true });
    } catch (err) {
      console.error('Failed to load frequency history:', err);
    }
  },

  add: (event) =>
    set((state) => state.events.some(e => e.id === event.id)
      ? state
      : { events: [event, ...state.events].slice(0, LOAD_LIMIT) }),
}));

// This history used to live in localStorage. Drop the old copy so it does not
// sit in the browser forever.
try { localStorage.removeItem('rfdeck-freq-history'); } catch { /* storage may be blocked */ }
