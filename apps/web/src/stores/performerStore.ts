import { create } from 'zustand';
import { Performer } from '@rfdeck/shared-types';
import { apiFetch } from '../lib/api';

// The performer roster: people, independent of any show.
//
// Server-authoritative like shows. The server broadcasts the whole list on
// every change (`performers:updated`), so every client sees the same roster
// without refetching.

interface PerformerStore {
  performers: Performer[];
  loaded: boolean;
  error: string | null;

  fetchPerformers: () => Promise<void>;
  /** Applied from socket events; never called directly by components. */
  applyServerList: (list: Performer[]) => void;

  addPerformer: (name: string, notes?: string) => Promise<boolean>;
  updatePerformer: (id: string, partial: { name?: string; notes?: string }) => Promise<void>;
  deletePerformer: (id: string) => Promise<void>;
}

export const usePerformerStore = create<PerformerStore>()((set) => ({
  performers: [],
  loaded: false,
  error: null,

  fetchPerformers: async () => {
    try {
      const performers = await apiFetch<Performer[]>('/performers');
      set({ performers, loaded: true, error: null });
    } catch (err: any) {
      set({ error: err?.message ?? 'Could not load performers', loaded: true });
    }
  },

  applyServerList: (performers) => set({ performers, loaded: true }),

  addPerformer: async (name, notes = '') => {
    try {
      const performers = await apiFetch<Performer[]>('/performers', {
        method: 'POST',
        body: JSON.stringify({ name, notes }),
      });
      set({ performers, error: null });
      return true;
    } catch (err: any) {
      set({ error: err?.message ?? 'Could not add the performer' });
      return false;
    }
  },

  updatePerformer: async (id, partial) => {
    // Optimistic: these are text inputs, so waiting on a round trip per
    // keystroke would make the field feel broken. The broadcast reconciles.
    set(s => ({
      performers: s.performers.map(p => (p.id === id ? { ...p, ...partial } : p)),
    }));
    try {
      await apiFetch(`/performers/${id}`, { method: 'PUT', body: JSON.stringify(partial) });
    } catch (err: any) {
      set({ error: err?.message ?? 'Could not save the change' });
    }
  },

  deletePerformer: async (id) => {
    set(s => ({ performers: s.performers.filter(p => p.id !== id) }));
    try {
      await apiFetch(`/performers/${id}`, { method: 'DELETE' });
    } catch (err: any) {
      set({ error: err?.message ?? 'Could not remove the performer' });
    }
  },
}));
