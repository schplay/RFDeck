import { create } from 'zustand';
import {
  PersonSession, DeviceCodeStart, loadSession, saveSession,
  startPersonLink, pollPersonLink, endPersonLink,
} from '../lib/personLink';
import { syncProfile, pushProfile, SyncResult } from '../lib/profileSync';
import { useCloudStore } from './cloudStore';

/**
 * Who is signed in *in this browser*, and their synced preferences.
 *
 * Entirely client-side. The session never reaches the RFDeck server, because a
 * venue machine is shared and a personal token on it would outlive the person
 * using it. Everything here works — or fails — without affecting the rig.
 */

interface PersonState {
  session: PersonSession | null;
  pending: DeviceCodeStart | null;
  outcome: 'pending' | 'linked' | 'denied' | 'expired' | 'error' | null;
  error: string | null;
  syncing: boolean;
  lastSync: SyncResult | null;

  signIn: () => Promise<void>;
  cancel: () => void;
  signOut: () => Promise<void>;
  sync: () => Promise<void>;
  pushNow: (keys?: string[]) => Promise<void>;
}

let poller: ReturnType<typeof setTimeout> | null = null;

export const usePersonStore = create<PersonState>()((set, get) => ({
  // Restored from session storage, so a page reload does not sign someone out.
  session: loadSession(),
  pending: null,
  outcome: null,
  error: null,
  syncing: false,
  lastSync: null,

  signIn: async () => {
    const { baseUrl, browserClientId } = useCloudStore.getState().status;
    if (!baseUrl || !browserClientId) {
      set({ error: 'This server has no Meros browser client configured.' });
      return;
    }
    set({ error: null, outcome: 'pending' });
    try {
      const pending = await startPersonLink(baseUrl, browserClientId);
      set({ pending });

      // The browser polls, not the server — the whole point of using the device
      // grant here is that nothing personal passes through the venue machine.
      const tick = async () => {
        const current = get().pending;
        if (!current) return;
        if (Date.now() > current.expiresAt) {
          set({ outcome: 'expired', pending: null });
          return;
        }
        const result = await pollPersonLink(baseUrl, browserClientId, current.deviceCode, current.intervalMs);
        switch (result.state) {
          case 'pending':
            poller = setTimeout(() => void tick(), current.intervalMs);
            return;
          case 'slow_down':
            set({ pending: { ...current, intervalMs: result.intervalMs } });
            poller = setTimeout(() => void tick(), result.intervalMs);
            return;
          case 'linked':
            set({ session: result.session, pending: null, outcome: 'linked' });
            // Reconcile preferences straight away: the reason someone signs in is
            // to get their own layout back.
            void get().sync();
            return;
          case 'denied':
            set({ outcome: 'denied', pending: null });
            return;
          case 'expired':
            set({ outcome: 'expired', pending: null });
            return;
          case 'error':
            set({ outcome: 'error', error: result.message, pending: null });
            return;
        }
      };
      poller = setTimeout(() => void tick(), pending.intervalMs);
    } catch (err) {
      set({ outcome: 'error', error: (err as Error).message, pending: null });
    }
  },

  cancel: () => {
    if (poller) { clearTimeout(poller); poller = null; }
    set({ pending: null, outcome: null });
  },

  signOut: async () => {
    const { baseUrl, browserClientId } = useCloudStore.getState().status;
    const session = get().session;
    set({ session: null, lastSync: null, outcome: null });
    saveSession(null);
    if (baseUrl && browserClientId) {
      await endPersonLink(baseUrl, browserClientId, session);
    }
  },

  sync: async () => {
    const session = get().session;
    const { baseUrl } = useCloudStore.getState().status;
    if (!session || !baseUrl) return;
    set({ syncing: true, error: null });
    try {
      set({ lastSync: await syncProfile(baseUrl, session) });
    } catch (err) {
      // A sync failure changes nothing about whether RFDeck works, so it is
      // reported and dropped rather than retried in a loop.
      set({ error: (err as Error).message });
    } finally {
      set({ syncing: false });
    }
  },

  pushNow: async (keys) => {
    const session = get().session;
    const { baseUrl } = useCloudStore.getState().status;
    if (!session || !baseUrl) return;
    try {
      await pushProfile(baseUrl, session, keys);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));
