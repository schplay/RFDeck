import { create } from 'zustand';
import { API_BASE, apiFetch } from '../lib/api';

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
  /** The RFDeck Browser client, for the person link's own device flow. */
  browserClientId: string | null;
  baseUrl: string | null;
}

/** A device-flow attempt the server is polling on our behalf. */
export interface PendingLink {
  pending: boolean;
  outcome?: 'pending' | 'linked' | 'denied' | 'expired' | 'error';
  detail?: string | null;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string | null;
  expiresAt?: string;
}

const EMPTY: CloudStatus = {
  configured: false, linked: false, accountId: null, linkedAt: null,
  lastRefreshAt: null, features: [], expiresAt: null, offline: false,
  needsRelink: null, browserClientId: null, baseUrl: null,
};

interface CloudState {
  status: CloudStatus;
  loaded: boolean;
  pending: PendingLink | null;
  busy: boolean;
  error: string | null;

  fetchStatus: () => Promise<void>;
  setStatus: (status: CloudStatus) => void;
  startLink: () => Promise<void>;
  pollLink: () => Promise<void>;
  cancelLink: () => Promise<void>;
  unlink: () => Promise<void>;
}

export const useCloudStore = create<CloudState>()((set, get) => ({
  status: EMPTY,
  loaded: false,
  pending: null,
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

  startLink: async () => {
    set({ busy: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/cloud/link`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      set({ pending: { pending: true, ...body } });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  pollLink: async () => {
    try {
      const res = await fetch(`${API_BASE}/cloud/link`);
      const body: PendingLink = await res.json();
      set({ pending: body.outcome ? body : null });
      // A completed link changes what the rest of the page should say.
      if (body.outcome && body.outcome !== 'pending') await get().fetchStatus();
    } catch {
      /* transient; the next tick tries again */
    }
  },

  cancelLink: async () => {
    try { await apiFetch('/cloud/link', { method: 'DELETE' }); } catch { /* ignore */ }
    set({ pending: null });
  },

  unlink: async () => {
    set({ busy: true, error: null });
    try {
      await apiFetch('/cloud/unlink', { method: 'POST' });
      set({ pending: null });
      await get().fetchStatus();
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },
}));
