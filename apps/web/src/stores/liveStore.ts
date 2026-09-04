import { create } from 'zustand';
import { apiFetch } from '../lib/api';

// Whether RFDeck is working the rig.
//
// Going live tracks every device, starts capture and fault detection, and puts
// the show's cast on the Micboard. Standing down reverses all three. It is one
// state on the server, not a per-client preference — an operator at FOH and a
// display backstage must never disagree about whether anything is running.

export interface LiveState {
  live: boolean;
  startedAt: string | null;
  show: { id: string; name: string; currentAct: number } | null;
}

interface LiveStore extends LiveState {
  loaded: boolean;
  busy: boolean;
  error: string | null;

  fetchLive: () => Promise<void>;
  /** Applied from the socket; never called directly by components. */
  applyServer: (next: LiveState) => void;

  goLive: (showId: string | null) => Promise<boolean>;
  standDown: () => Promise<void>;
}

export const useLiveStore = create<LiveStore>()((set) => ({
  live: false,
  startedAt: null,
  show: null,
  loaded: false,
  busy: false,
  error: null,

  fetchLive: async () => {
    try {
      const next = await apiFetch<LiveState>('/live');
      set({ ...next, loaded: true, error: null });
    } catch (err: any) {
      set({ loaded: true, error: err?.message ?? 'Could not read the live state' });
    }
  },

  applyServer: (next) => set({ ...next, loaded: true }),

  goLive: async (showId) => {
    set({ busy: true, error: null });
    try {
      // Enabling every device and opening captures takes a moment, so this is
      // not optimistic — the button stays busy until the server has actually
      // done it, rather than claiming success and being wrong.
      const next = await apiFetch<LiveState>('/live', {
        method: 'POST',
        body: JSON.stringify({ showId }),
      });
      set({ ...next, busy: false });
      return true;
    } catch (err: any) {
      set({ busy: false, error: err?.message ?? 'Could not go live' });
      return false;
    }
  },

  standDown: async () => {
    set({ busy: true, error: null });
    try {
      const next = await apiFetch<LiveState>('/live', { method: 'DELETE' });
      set({ ...next, busy: false });
    } catch (err: any) {
      set({ busy: false, error: err?.message ?? 'Could not stand down' });
    }
  },
}));
