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

  /**
   * When true, nothing that changes the rig or the record can be operated.
   *
   * `mutesLocked` covers the single most dangerous button. This covers the rest
   * of them: enabling and disabling devices, going live and standing down,
   * repatching audio, ticking a mic check. All are one click, all are things a
   * sleeve or a stray tap can do to a tablet propped at FOH, and several are
   * not obviously undoable once the show is running.
   *
   * Unlike `mutesLocked` this defaults to OFF. Locked-by-default is right for
   * one button whose purpose is obvious; an application that silently ignores
   * every control until you find the switch is just broken. Locking is an act
   * with an occasion — the house opens — so it waits to be asked.
   */
  surfaceLocked: boolean;
  setSurfaceLocked: (locked: boolean) => void;
}

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      mutesLocked: true,
      setMutesLocked: (mutesLocked) => set({ mutesLocked }),
      surfaceLocked: false,
      setSurfaceLocked: (surfaceLocked) => set({ surfaceLocked }),
    }),
    { name: 'rfdeck-ui' },
  ),
);

/**
 * Whether a control that changes the rig or the record should be inert.
 *
 * One place to ask, so a control added later is either covered or visibly not —
 * rather than each caller reading the flag and one of them forgetting.
 */
export function useSurfaceLocked(): boolean {
  return useUiStore(s => s.surfaceLocked);
}

/** The reason a control is inert, for a tooltip that explains rather than sulks. */
export const LOCKED_REASON =
  'The surface is locked. Unlock it in the header to make changes.';
