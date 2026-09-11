import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Ballistics, Thresholds } from '../lib/meterMath';

// How meters look and behave. Per browser, persisted.
//
// These are preferences, not facts about the rig, which is why they live here
// rather than in server settings: the person at FOH and the person on the
// backstage tablet can reasonably want different ballistics and different
// colours, and neither should overrule the other.
//
// Before this every view carried its own compiled-in copy of these — and they
// disagreed. RF turned red at 20% in three views while the server alerts at
// 25%; audio warned at 60% in two views and 80% in the third; and each had its
// own palette. Nobody chose that. The defaults below are the one set every
// view now shares, and the RF ones are the server's alert thresholds so that
// out of the box a red meter and a dropout alert mean the same thing.

export interface MeterSettings {
  peakHold: boolean;
  peakHoldMs: number;
  ballistics: Ballistics;
  rf: Thresholds;
  af: Thresholds;
  colors: { good: string; warn: string; crit: string };
}

export const METER_DEFAULTS: MeterSettings = {
  peakHold: true,
  peakHoldMs: 1500,
  ballistics: 'fast',
  // Low is bad. 25 is where the server confirms a dropout, 45 where it
  // declares recovery — see DEFAULT_RF_THRESHOLDS on the server.
  rf: { warn: 45, crit: 25 },
  // High is bad. 80 is hot, 92 is about to clip on most receivers' scales.
  af: { warn: 80, crit: 92 },
  colors: { good: '#4ade80', warn: '#fb923c', crit: '#f87171' },
};

interface MeterStore extends MeterSettings {
  update: (partial: Partial<MeterSettings>) => void;
  reset: () => void;
}

export const useMeterStore = create<MeterStore>()(
  persist(
    (set) => ({
      ...METER_DEFAULTS,
      update: (partial) => set(partial),
      reset: () => set({ ...METER_DEFAULTS }),
    }),
    { name: 'rfdeck-meters' },
  ),
);
