import { create } from 'zustand';
import {
  PersonSession, DeviceCodeStart, loadSession, saveSession,
  startPersonLink, pollPersonLink, endPersonLink, PersonSignedOut,
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

  /** Whether to keep the session past this tab — the operator's call. */
  remember: boolean;
  setRemember: (remember: boolean) => void;
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
  // Off by default: a venue PC is the common case, and a session that ends with
  // the tab is the safer default to offer there. Somebody on their own laptop
  // ticks the box once.
  remember: loadSession()?.persistent ?? false,

  setRemember: remember => set({ remember }),

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
        const result = await pollPersonLink(
          baseUrl, browserClientId, current.deviceCode, current.intervalMs, get().remember,
        );
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
    const { browserClientId } = useCloudStore.getState().status;
    set({ syncing: true, error: null });
    try {
      set({
        lastSync: await syncProfile(
          baseUrl, session, browserClientId ?? undefined,
          renewed => set({ session: renewed }),
        ),
      });
    } catch (err) {
      // A sync failure changes nothing about whether RFDeck works, so it is
      // reported and dropped rather than retried in a loop. A session that has
      // genuinely ended is different: clear it, so the menu offers sign-in rather
      // than pretending somebody is still there.
      if (err instanceof PersonSignedOut) {
        set({ session: null, error: err.message });
      } else {
        set({ error: (err as Error).message });
      }
    } finally {
      set({ syncing: false });
    }
  },

  pushNow: async (keys) => {
    const session = get().session;
    const { baseUrl } = useCloudStore.getState().status;
    if (!session || !baseUrl) return;
    const { browserClientId } = useCloudStore.getState().status;
    try {
      await pushProfile(
        baseUrl, session, keys, browserClientId ?? undefined,
        renewed => set({ session: renewed }),
      );
    } catch (err) {
      if (err instanceof PersonSignedOut) set({ session: null, error: err.message });
      else set({ error: (err as Error).message });
    }
  },
}));
