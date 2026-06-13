import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Alert } from '@rfdeck/shared-types';

interface AlertStore {
  alerts: Alert[];
  addAlert: (alert: Alert) => void;
  acknowledgeAlert: (id: string) => void;
  dismissAlert: (id: string) => void;
  clearAll: () => void;
}

export const useAlertStore = create<AlertStore>()(
  persist(
    (set) => ({
      alerts: [],
      addAlert: (alert) =>
        set((state) => {
          const newAlerts = [alert, ...state.alerts].slice(0, 500); // Keep last 500
          return { alerts: newAlerts };
        }),
      acknowledgeAlert: (id) =>
        set((state) => ({
          alerts: state.alerts.map((a) =>
            a.id === id ? { ...a, acknowledged: true } : a
          ),
        })),
      dismissAlert: (id) =>
        set((state) => ({
          alerts: state.alerts.map((a) =>
            a.id === id ? { ...a, dismissed: true } : a
          ),
        })),
      clearAll: () => set({ alerts: [] }),
    }),
    {
      name: 'rfdeck-alerts',
    }
  )
);
