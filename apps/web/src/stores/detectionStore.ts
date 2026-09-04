import { create } from 'zustand';
import { apiFetch } from '../lib/api';

// Detections: incidents that looked like wireless faults, with the audio that
// proves them. Server-authoritative — a clip flagged at FOH is flagged
// backstage too — so socket events drive this rather than local edits.

export interface Detection {
  id: string;
  timestamp: string;
  channelKey: string;
  channelName: string | null;
  deviceId: string | null;
  trigger: string;
  severity: string;
  message: string;
  rfLevelA: number | null;
  rfLevelB: number | null;
  showId: string | null;
  act: number | null;
  /** Null when the clip is still being captured, or was pruned. */
  clipPath: string | null;
  clipBytes: number;
  clipMs: number;
  flagged: boolean;
  note: string | null;
  dismissed: boolean;
}

export interface RecordingStatus {
  enabled: boolean;
  maxMb: number;
  usedMb: number;
  clipCount: number;
  freeMb: number | null;
  totalMb: number | null;
  preSec: number;
  postSec: number;
  channels: Array<{ channelKey: string; deviceId: string; inputChannel: number }>;
  directory: string;
}

interface DetectionStore {
  detections: Detection[];
  status: RecordingStatus | null;
  loading: boolean;
  error: string | null;

  fetchDetections: (opts?: { includeDismissed?: boolean }) => Promise<void>;
  fetchStatus: () => Promise<void>;

  /** Applied from socket events; never called directly by components. */
  applyNew: (d: Detection) => void;
  applyUpdated: (d: Detection) => void;
  applyDeleted: (id: string) => void;
  applyPruned: (ids: string[]) => void;

  setFlagged: (id: string, flagged: boolean) => Promise<void>;
  setNote: (id: string, note: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const byNewest = (a: Detection, b: Detection) =>
  new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();

export const useDetectionStore = create<DetectionStore>()((set, get) => ({
  detections: [],
  status: null,
  loading: false,
  error: null,

  fetchDetections: async (opts) => {
    set({ loading: true, error: null });
    try {
      const q = opts?.includeDismissed ? '?includeDismissed=1' : '';
      const data = await apiFetch<{ detections: Detection[] }>(`/detections${q}`);
      set({ detections: data.detections, loading: false });
    } catch (err: any) {
      set({ error: err?.message ?? 'Could not load detections', loading: false });
    }
  },

  fetchStatus: async () => {
    try {
      set({ status: await apiFetch<RecordingStatus>('/recording/status') });
    } catch {
      set({ status: null });
    }
  },

  applyNew: (d) => set(s => (
    s.detections.some(x => x.id === d.id)
      ? s
      : { detections: [d, ...s.detections].sort(byNewest) }
  )),

  applyUpdated: (d) => set(s => ({
    detections: s.detections.some(x => x.id === d.id)
      ? s.detections.map(x => (x.id === d.id ? d : x))
      : [d, ...s.detections].sort(byNewest),
  })),

  applyDeleted: (id) => set(s => ({ detections: s.detections.filter(d => d.id !== id) })),

  // Pruned clips keep their detection — only the audio is gone.
  applyPruned: (ids) => set(s => ({
    detections: s.detections.map(d =>
      ids.includes(d.id) ? { ...d, clipPath: null, clipBytes: 0 } : d),
  })),

  setFlagged: async (id, flagged) => {
    const before = get().detections;
    set(s => ({ detections: s.detections.map(d => (d.id === id ? { ...d, flagged } : d)) }));
    try {
      await apiFetch(`/detections/${id}`, { method: 'PATCH', body: JSON.stringify({ flagged }) });
    } catch (err: any) {
      set({ detections: before, error: err?.message ?? 'Could not save that flag' });
    }
  },

  setNote: async (id, note) => {
    set(s => ({ detections: s.detections.map(d => (d.id === id ? { ...d, note } : d)) }));
    try {
      await apiFetch(`/detections/${id}`, { method: 'PATCH', body: JSON.stringify({ note }) });
    } catch (err: any) {
      set({ error: err?.message ?? 'Could not save that note' });
    }
  },

  dismiss: async (id) => {
    const before = get().detections;
    set(s => ({ detections: s.detections.filter(d => d.id !== id) }));
    try {
      await apiFetch(`/detections/${id}`, { method: 'PATCH', body: JSON.stringify({ dismissed: true }) });
    } catch (err: any) {
      set({ detections: before, error: err?.message ?? 'Could not dismiss that detection' });
    }
  },

  remove: async (id) => {
    const before = get().detections;
    set(s => ({ detections: s.detections.filter(d => d.id !== id) }));
    try {
      await apiFetch(`/detections/${id}`, { method: 'DELETE' });
    } catch (err: any) {
      set({ detections: before, error: err?.message ?? 'Could not delete that detection' });
    }
  },
}));
