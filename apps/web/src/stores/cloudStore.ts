import { create } from 'zustand';
import { API_BASE, apiFetch } from '../lib/api';
import { signInWithMeros, cancelSignIn, pendingSignInPage, signInMessage } from '../lib/signIn';

/**
 * The Meros Cloud link, as the UI sees it.
 *
 * Every field has a sensible value when the cloud is unconfigured, unlinked or
 * unreachable, because all three are ordinary states for a rig on a show LAN —
 * not errors to surface.
 */

export interface CloudStatus {
  configured: boolean;
  linked: boolean;
  accountId: string | null;
  linkedAt: string | null;
  lastRefreshAt: string | null;
  /** Namespaced `rfdeck.*` features the account holds. */
  features: string[];
  expiresAt: string | null;
  /** Working from a cached entitlement because the last read did not get through. */
  offline: boolean;
  /** The link is dead and only the operator can fix it, with the reason. */
  needsRelink: string | null;
  /** Whether people can sign in here to sync their preferences. */
  peopleCanSignIn: boolean;
  /** The Meros origin this install talks to. */
  baseUrl: string | null;
  /** Whether the event stream is being sent to the cloud. Off by default. */
  eventsToCloud: boolean;
  /** Events waiting to be sent — an offline backlog, visible rather than silent. */
  eventsQueued: number;
}

const EMPTY: CloudStatus = {
  configured: false, linked: false, accountId: null, linkedAt: null,
  lastRefreshAt: null, features: [], expiresAt: null, offline: false,
  needsRelink: null, peopleCanSignIn: false, baseUrl: null,
  eventsToCloud: false, eventsQueued: 0,
};

interface CloudState {
  status: CloudStatus;
  loaded: boolean;
  /** Linking through the system browser (RFDeck Desktop), until it comes back. */
  linking: boolean;
  /** The page the system browser was opened at, for when it didn't come up. */
  linkingPage: string | null;
  busy: boolean;
  error: string | null;

  fetchStatus: () => Promise<void>;
  setStatus: (status: CloudStatus) => void;
  /** Link this RFDeck to a Meros account by signing in with Meros. */
  link: () => Promise<void>;
  cancelLink: () => Promise<void>;
  /** A link that meros.co sent this page back from. */
  linkReturned: (error: string | null) => Promise<void>;
  unlink: () => Promise<void>;
  setEventsToCloud: (enabled: boolean) => Promise<void>;
}

export const useCloudStore = create<CloudState>()((set, get) => ({
  status: EMPTY,
  loaded: false,
  linking: false,
  linkingPage: null,
  busy: false,
  error: null,

  fetchStatus: async () => {
    try {
      const res = await fetch(`${API_BASE}/cloud/status`);
      set({ status: await res.json(), loaded: true });
    } catch {
      // The server being unreachable is a different problem from the cloud
      // being unreachable, and the shell already says so.
      set({ loaded: true });
    }
  },

  /** From the `cloud:status` socket event, so every open client stays in step. */
  setStatus: (status) => set({ status, loaded: true }),

  link: async () => {
    set({ linking: true, linkingPage: null, error: null });
    const watch = setInterval(() => {
      void pendingSignInPage().then(page => { if (get().linking) set({ linkingPage: page }); });
    }, 1000);
    try {
      const result = await signInWithMeros('instance');
      if (result.redirected) return;
      await get().fetchStatus();
      set({ linking: false, linkingPage: null });
    } catch (err) {
      set({ linking: false, linkingPage: null, error: (err as Error).message });
    } finally {
      clearInterval(watch);
    }
  },

  cancelLink: async () => {
    await cancelSignIn();
    set({ linking: false, linkingPage: null });
  },

  linkReturned: async (error) => {
    set({ error: error ? signInMessage(error) : null });
    await get().fetchStatus();
  },

  setEventsToCloud: async (enabled) => {
    // Optimistic: the switch should feel immediate, and a failure reverts it when
    // status is re-read.
    set(state => ({ status: { ...state.status, eventsToCloud: enabled } }));
    try {
      await apiFetch('/cloud/events', { method: 'PUT', body: JSON.stringify({ enabled }) });
    } catch (err) {
      set({ error: (err as Error).message });
    }
    await get().fetchStatus();
  },

  unlink: async () => {
    set({ busy: true, error: null });
    try {
      await apiFetch('/cloud/unlink', { method: 'POST' });
      await get().fetchStatus();
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },
}));
