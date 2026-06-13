import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Show, ShowSlot, MicCheckStatus } from '@rfdeck/shared-types';

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface ShowStore {
  shows: Show[];
  activeShowId: string | null;

  // Show CRUD
  createShow: (name: string, mode: Show['environmentMode']) => Show;
  updateShow: (id: string, partial: Partial<Omit<Show, 'id' | 'slots' | 'createdAt'>>) => void;
  deleteShow: (id: string) => void;
  setActiveShow: (id: string | null) => void;

  // Slot management
  addSlot: (showId: string, name: string) => void;
  updateSlot: (showId: string, slotId: string, partial: Partial<ShowSlot>) => void;
  deleteSlot: (showId: string, slotId: string) => void;
  reorderSlots: (showId: string, orderedIds: string[]) => void;

  // Mic check
  setMicCheckStatus: (showId: string, slotId: string, status: MicCheckStatus, notes?: string) => void;
  resetMicCheck: (showId: string) => void;
}

export const useShowStore = create<ShowStore>()(
  persist(
    (set, get) => ({
      shows: [],
      activeShowId: null,

      createShow: (name, mode) => {
        const now = new Date().toISOString();
        const show: Show = {
          id: uuid(),
          name,
          environmentMode: mode,
          slots: [],
          createdAt: now,
          updatedAt: now,
        };
        set(s => ({ shows: [...s.shows, show] }));
        return show;
      },

      updateShow: (id, partial) => {
        set(s => ({
          shows: s.shows.map(sh =>
            sh.id === id ? { ...sh, ...partial, updatedAt: new Date().toISOString() } : sh
          )
        }));
      },

      deleteShow: (id) => {
        set(s => ({
          shows: s.shows.filter(sh => sh.id !== id),
          activeShowId: s.activeShowId === id ? null : s.activeShowId,
        }));
      },

      setActiveShow: (id) => set({ activeShowId: id }),

      addSlot: (showId, name) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            const slot: ShowSlot = {
              id: uuid(),
              showId,
              name,
              order: sh.slots.length,
              assignedChannelIds: [],
              micCheckStatus: 'PENDING',
            };
            return { ...sh, slots: [...sh.slots, slot], updatedAt: new Date().toISOString() };
          })
        }));
      },

      updateSlot: (showId, slotId, partial) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            return {
              ...sh,
              slots: sh.slots.map(sl => sl.id === slotId ? { ...sl, ...partial } : sl),
              updatedAt: new Date().toISOString(),
            };
          })
        }));
      },

      deleteSlot: (showId, slotId) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            return {
              ...sh,
              slots: sh.slots.filter(sl => sl.id !== slotId).map((sl, i) => ({ ...sl, order: i })),
              updatedAt: new Date().toISOString(),
            };
          })
        }));
      },

      reorderSlots: (showId, orderedIds) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            const slotMap = Object.fromEntries(sh.slots.map(sl => [sl.id, sl]));
            return {
              ...sh,
              slots: orderedIds.map((id, i) => ({ ...slotMap[id], order: i })),
              updatedAt: new Date().toISOString(),
            };
          })
        }));
      },

      setMicCheckStatus: (showId, slotId, status, notes) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            return {
              ...sh,
              slots: sh.slots.map(sl =>
                sl.id === slotId
                  ? { ...sl, micCheckStatus: status, micCheckNotes: notes ?? sl.micCheckNotes, micCheckTimestamp: new Date().toISOString() }
                  : sl
              ),
              updatedAt: new Date().toISOString(),
            };
          })
        }));
      },

      resetMicCheck: (showId) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            return {
              ...sh,
              slots: sh.slots.map(sl => ({ ...sl, micCheckStatus: 'PENDING', micCheckNotes: undefined, micCheckTimestamp: undefined })),
              updatedAt: new Date().toISOString(),
            };
          })
        }));
      },
    }),
    { name: 'rfdeck-shows' }
  )
);
