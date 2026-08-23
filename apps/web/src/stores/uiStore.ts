import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Operator-facing safety switches. Per browser, persisted, so a display that
// was locked before the house opened is still locked after a reload.

interface UiStore {
  /**
   * When true, every Mute button on every channel card is inert.
   *
   * Muting a live receiver from the dashboard is one click away from silencing
   * a performer mid-line, and a dashboard is routinely touched during a show —
   * to scroll, to check a battery, to listen. Locked is therefore the resting
   * state; unlocking is the deliberate act.
   */
  mutesLocked: boolean;
  setMutesLocked: (locked: boolean) => void;
}

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      mutesLocked: true,
      setMutesLocked: (mutesLocked) => set({ mutesLocked }),
    }),
    { name: 'rfdeck-ui' },
  ),
);
