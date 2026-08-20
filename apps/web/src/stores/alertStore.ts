import { create } from 'zustand';
import { Alert } from '@rfdeck/shared-types';
import { apiFetch } from '../lib/api';

// Alerts are server-owned and shared across clients.
//
// Acknowledgement used to be client-local, which meant one operator clearing an
// alert left it live for everyone else — two people then respond to the same
// incident, or nobody does because each assumes the other saw it handled.
// Ack and dismiss now round-trip to the server and broadcast.
//
// Deliberately not persisted: the server replays on connect, so a local copy
// could only conflict with it.

interface AlertStore {
  alerts: Alert[];
  addAlert: (alert: Alert) => void;
  /** Applied from the alert:updated broadcast. */
  applyServerAlert: (alert: Alert) => void;
  acknowledgeAlert: (id: string) => Promise<void>;
  dismissAlert: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  applyServerClear: () => void;
}

export const useAlertStore = create<AlertStore>()((set) => ({
  alerts: [],

  addAlert: (alert) =>
    set((state) => {
      // The server replays on reconnect — don't duplicate.
      if (state.alerts.some((a) => a.id === alert.id)) return state;
      return { alerts: [alert, ...state.alerts].slice(0, 500) };
    }),

  applyServerAlert: (alert) =>
    set((state) => ({
      alerts: state.alerts.map((a) => (a.id === alert.id ? { ...a, ...alert } : a)),
    })),

  acknowledgeAlert: async (id) => {
    // Optimistic — during a show the operator needs the click to register now.
    set((state) => ({
      alerts: state.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
    }));
    try {
      await apiFetch(`/alerts/${id}/ack`, { method: 'POST', body: JSON.stringify({}) });
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
      set((state) => ({
        alerts: state.alerts.map((a) => (a.id === id ? { ...a, acknowledged: false } : a)),
      }));
    }
  },

  dismissAlert: async (id) => {
    set((state) => ({
      alerts: state.alerts.map((a) => (a.id === id ? { ...a, dismissed: true } : a)),
    }));
    try {
      await apiFetch(`/alerts/${id}/dismiss`, { method: 'POST', body: JSON.stringify({}) });
    } catch (err) {
      console.error('Failed to dismiss alert:', err);
      set((state) => ({
        alerts: state.alerts.map((a) => (a.id === id ? { ...a, dismissed: false } : a)),
      }));
    }
  },

  clearAll: async () => {
    try {
      await apiFetch('/alerts', { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to clear alerts:', err);
    }
  },

  applyServerClear: () => set({ alerts: [] }),
}));
