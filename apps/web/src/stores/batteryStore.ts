import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface BatteryEstimate {
  channelId: string;
  /** Percent per hour, positive while draining. */
  drainPerHour: number;
  /** Minutes until empty, or null when the server isn't confident yet. */
  minutesRemaining: number | null;
  confident: boolean;
}

interface BatteryStore {
  estimates: Record<string, BatteryEstimate>;
  /** Operator's expected remaining running time, in minutes. */
  showMinutes: number;
  applyEstimate: (est: BatteryEstimate) => void;
  setShowMinutes: (minutes: number) => void;
}

// Estimates are computed on the server from its own sampling history, so this
// store is a passive receiver — a client that just connected gets the full
// picture immediately instead of having to accumulate an hour of readings.
export const useBatteryStore = create<BatteryStore>()(
  persist(
    (set) => ({
      estimates: {},
      showMinutes: 120,
      applyEstimate: (est) =>
        set((state) => ({ estimates: { ...state.estimates, [est.channelId]: est } })),
      setShowMinutes: (minutes) => set({ showMinutes: Math.max(0, minutes) }),
    }),
    {
      name: 'rfdeck-battery',
      // Only the operator's show length is worth remembering; estimates come
      // from the server on connect.
      partialize: (state) => ({ showMinutes: state.showMinutes }) as any,
    }
  )
);

// "2h 15m" / "45m" / "—"
export function formatRuntime(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  if (minutes < 1) return '<1m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
