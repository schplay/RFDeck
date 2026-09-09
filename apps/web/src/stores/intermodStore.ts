import { create } from 'zustand';

// The intermodulation picture, as the server last computed it.
//
// Server-side because it is a property of the whole rig rather than of any one
// client's view, and because the search is cubic in the worst case — doing it
// once and telling everybody beats every open tab working it out again. Pushed
// when a frequency changes and replayed on connect, since between re-tunes
// there is nothing to push and a client arriving late would otherwise show an
// empty panel on a rig with a real problem.

export interface IntermodHit {
  victimId: string;
  victimName: string;
  productKHz: number;
  offsetKHz: number;
  order: 3 | 5;
  kind: '2TX3' | '3TX3' | '2TX5';
  causeIds: string[];
  formula: string;
}

export interface IntermodReport {
  hits: IntermodHit[];
  truncated: boolean;
  sourceCount: number;
}

interface IntermodStore {
  report: IntermodReport;
  applyReport: (report: IntermodReport) => void;
  /** The hits landing on one channel, for a warning on its card. */
  hitsFor: (channelId: string) => IntermodHit[];
}

export const useIntermodStore = create<IntermodStore>()((set, get) => ({
  report: { hits: [], truncated: false, sourceCount: 0 },
  applyReport: (report) => set({ report }),
  hitsFor: (channelId) => get().report.hits.filter(h => h.victimId === channelId),
}));
