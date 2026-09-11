import { create } from 'zustand';
import { apiFetch } from '../lib/api';

// Spectrum scans, as imported into the server. The environment layer under
// the frequency map, and the source of "keep out of what the scan shows"
// for coordination. One scan is selected at a time; its levels are fetched
// on selection rather than with the list, since a scan is thousands of
// points and the list is a menu.

export interface ScanMeta {
  id: string; name: string; source: string; takenAt: string;
  startKHz: number; stepKHz: number; points: number; endKHz: number; createdAt: string;
}
export interface ScanData extends ScanMeta { levelsDbm: Array<number | null> }

interface ScanStore {
  scans: ScanMeta[];
  selectedId: string | null;
  selected: ScanData | null;
  load: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  importText: (name: string, text: string) => Promise<ScanMeta>;
  remove: (id: string) => Promise<void>;
}

const SELECTED_KEY = 'rfdeck-scan-selected';

export const useScanStore = create<ScanStore>()((set, get) => ({
  scans: [],
  selectedId: null,
  selected: null,

  load: async () => {
    const scans = await apiFetch<ScanMeta[]>('/scans');
    set({ scans });
    // Re-select what this browser had, if it still exists.
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(SELECTED_KEY); } catch { /* private mode */ }
    const want = get().selectedId ?? remembered;
    if (want && scans.some(s => s.id === want)) await get().select(want);
    else if (want) set({ selectedId: null, selected: null });
  },

  select: async (id) => {
    try { if (id) localStorage.setItem(SELECTED_KEY, id); else localStorage.removeItem(SELECTED_KEY); } catch { /* ignore */ }
    if (!id) { set({ selectedId: null, selected: null }); return; }
    set({ selectedId: id });
    const selected = await apiFetch<ScanData>(`/scans/${id}`);
    // Only apply if still wanted — a slower fetch must not overwrite a newer choice.
    if (get().selectedId === id) set({ selected });
  },

  importText: async (name, text) => {
    const created = await apiFetch<ScanMeta>('/scans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text }),
    });
    await get().load();
    await get().select(created.id);
    return created;
  },

  remove: async (id) => {
    await apiFetch(`/scans/${id}`, { method: 'DELETE' });
    if (get().selectedId === id) await get().select(null);
    await get().load();
  },
}));
