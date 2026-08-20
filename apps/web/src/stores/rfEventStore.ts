import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RfEventType = 'DROPOUT' | 'RECOVERY' | 'WEAK_SIGNAL';

export interface RfEvent {
  id: string;
  type: RfEventType;
  channelId: string;
  channelName: string;
  deviceId: string;
  rfLevelA: number;
  rfLevelB: number;
  timestamp: string;
}

const MAX_EVENTS = 500;
const DROPOUT_THRESHOLD  = 25; // % below which we call it a dropout
const RECOVERY_THRESHOLD = 45; // % above which we call it a recovery (hysteresis)
// A dropout is only logged if the signal stays below the threshold for this long.
// EW-DX diversity switching produces sub-second 0%→100% flaps that are inaudible;
// without this window they generate a DROPOUT+RECOVERY pair every second.
const DROPOUT_CONFIRM_MS = 3000;

// Transient per-channel state — deliberately NOT in the persisted store.
const pendingDropouts = new Map<string, ReturnType<typeof setTimeout>>();
const latestLevels = new Map<string, number>();

interface RfEventState {
  events: RfEvent[];
  // Per-channel state to implement hysteresis
  channelStates: Record<string, 'OK' | 'DROPOUT'>;
  addTelemetry: (channelId: string, channelName: string, deviceId: string, rfA: number, rfB: number) => void;
  clearAll: () => void;
  clearForChannel: (channelId: string) => void;
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const useRfEventStore = create<RfEventState>()(
  persist(
    (set, get) => ({
      events: [],
      channelStates: {},

      addTelemetry: (channelId, channelName, deviceId, rfA, rfB) => {
        const level = Math.max(rfA, rfB);
        latestLevels.set(channelId, level);
        const prevState = get().channelStates[channelId] ?? 'OK';

        const logEvent = (type: RfEventType, a: number, b: number, newState: 'OK' | 'DROPOUT') => {
          const event: RfEvent = {
            id: uid(),
            type,
            channelId,
            channelName,
            deviceId,
            rfLevelA: a,
            rfLevelB: b,
            timestamp: new Date().toISOString(),
          };
          set((state) => ({
            events: [event, ...state.events].slice(0, MAX_EVENTS),
            channelStates: { ...state.channelStates, [channelId]: newState },
          }));
        };

        if (prevState === 'OK') {
          if (level < DROPOUT_THRESHOLD) {
            // Don't log yet — start a confirm timer. If the signal recovers
            // before it fires, the flap never becomes an event.
            if (!pendingDropouts.has(channelId)) {
              pendingDropouts.set(channelId, setTimeout(() => {
                pendingDropouts.delete(channelId);
                const current = latestLevels.get(channelId);
                if (current === undefined || current >= DROPOUT_THRESHOLD) return;
                logEvent('DROPOUT', rfA, rfB, 'DROPOUT');
              }, DROPOUT_CONFIRM_MS));
            }
          } else {
            const timer = pendingDropouts.get(channelId);
            if (timer) {
              clearTimeout(timer);
              pendingDropouts.delete(channelId);
            }
          }
          return;
        }

        // prevState === 'DROPOUT'
        if (level >= RECOVERY_THRESHOLD) {
          logEvent('RECOVERY', rfA, rfB, 'OK');
        }
      },

      clearAll: () => {
        for (const timer of pendingDropouts.values()) clearTimeout(timer);
        pendingDropouts.clear();
        set({ events: [], channelStates: {} });
      },
      clearForChannel: (channelId) => {
        const timer = pendingDropouts.get(channelId);
        if (timer) {
          clearTimeout(timer);
          pendingDropouts.delete(channelId);
        }
        set((state) => ({
          events: state.events.filter((e) => e.channelId !== channelId),
          channelStates: Object.fromEntries(
            Object.entries(state.channelStates).filter(([k]) => k !== channelId)
          ),
        }));
      },
    }),
    { name: 'rfdeck-rf-events' }
  )
);
