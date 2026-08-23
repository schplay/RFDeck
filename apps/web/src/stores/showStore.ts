import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Show, Player, MicCheckAct } from '@rfdeck/shared-types';
import { apiFetch, API_BASE } from '../lib/api';

// Shows are server-authoritative. RFDeck runs as a network service with several
// clients, so a mic-check tick made backstage has to reach FOH — state lives on
// the server and arrives here via REST plus `show:*` socket events.
//
// Mutations apply optimistically so the mic-check keyboard flow stays instant,
// then reconcile with whatever the server broadcasts back.

interface ShowStore {
  shows: Show[];
  activeShowId: string | null;
  loaded: boolean;
  error: string | null;

  fetchShows: () => Promise<void>;
  /** Applied from socket events; never called directly by components. */
  applyServerShow: (show: Show) => void;
  applyServerDelete: (id: string) => void;

  createShow: (name: string, mode: Show['environmentMode']) => Promise<Show | null>;
  deleteShow: (id: string) => Promise<void>;
  setActiveShow: (id: string | null) => void;
  setShowArchived: (id: string, archived: boolean) => Promise<void>;

  /** Cast an existing performer (by id) or a typed name, which joins the roster. */
  addPlayer: (
    showId: string,
    who: { performerId?: string; realName?: string },
    characterName: string,
  ) => Promise<void>;
  updatePlayer: (showId: string, playerId: string, partial: Partial<Omit<Player, 'id' | 'showId'>>) => Promise<void>;
  deletePlayer: (showId: string, playerId: string) => Promise<void>;

  setCurrentAct: (showId: string, act: MicCheckAct) => Promise<void>;
  setChannelChecked: (showId: string, act: MicCheckAct, channelKey: string, checked: boolean) => Promise<void>;
  setChannelNotes: (showId: string, act: MicCheckAct, channelKey: string, notes: string) => Promise<void>;
  resetAct: (showId: string, act: MicCheckAct) => Promise<void>;
}

// Merge one show into the list, preserving order and appending if new.
function upsert(shows: Show[], next: Show): Show[] {
  const idx = shows.findIndex(s => s.id === next.id);
  if (idx < 0) return [...shows, next];
  const copy = [...shows];
  copy[idx] = next;
  return copy;
}

function patchShow(shows: Show[], id: string, fn: (s: Show) => Show): Show[] {
  return shows.map(s => (s.id === id ? fn(s) : s));
}

export const useShowStore = create<ShowStore>()(
  persist(
    (set, get) => ({
      shows: [],
      activeShowId: null,
      loaded: false,
      error: null,

      fetchShows: async () => {
        try {
          const shows = await apiFetch<Show[]>('/shows');
          set({ shows, loaded: true, error: null });
        } catch (err) {
          console.error('Failed to load shows:', err);
          set({ error: 'Could not load shows from the server', loaded: true });
        }
      },

      applyServerShow: (show) => set(s => ({ shows: upsert(s.shows, show) })),

      applyServerDelete: (id) => set(s => ({
        shows: s.shows.filter(sh => sh.id !== id),
        activeShowId: s.activeShowId === id ? null : s.activeShowId,
      })),

      createShow: async (name, mode) => {
        try {
          const show = await apiFetch<Show>('/shows', {
            method: 'POST',
            body: JSON.stringify({ name, environmentMode: mode }),
          });
          set(s => ({ shows: upsert(s.shows, show), activeShowId: show.id }));
          return show;
        } catch (err) {
          console.error('Failed to create show:', err);
          set({ error: 'Could not create the show' });
          return null;
        }
      },

      deleteShow: async (id) => {
        const prev = get().shows;
        set(s => ({
          shows: s.shows.filter(sh => sh.id !== id),
          activeShowId: s.activeShowId === id ? null : s.activeShowId,
        }));
        try {
          await apiFetch(`/shows/${id}`, { method: 'DELETE' });
        } catch (err) {
          console.error('Failed to delete show:', err);
          set({ shows: prev, error: 'Could not delete the show' });
        }
      },

      setActiveShow: (id) => set({ activeShowId: id }),

      setShowArchived: async (id, archived) => {
        set(s => ({ shows: patchShow(s.shows, id, sh => ({ ...sh, archived })) }));
        try {
          await apiFetch<Show>(`/shows/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ archived }),
          });
        } catch (err) {
          console.error('Failed to archive show:', err);
          set(s => ({ shows: patchShow(s.shows, id, sh => ({ ...sh, archived: !archived })) }));
        }
      },

      addPlayer: async (showId, who, characterName) => {
        try {
          const show = await apiFetch<Show>(`/shows/${showId}/players`, {
            method: 'POST',
            body: JSON.stringify({ ...who, characterName }),
          });
          set(s => ({ shows: upsert(s.shows, show) }));
        } catch (err) {
          console.error('Failed to add player:', err);
        }
      },

      updatePlayer: async (showId, playerId, partial) => {
        // Optimistic: these are text inputs, so waiting on a round trip per
        // keystroke would make the field feel broken.
        set(s => ({
          shows: patchShow(s.shows, showId, sh => ({
            ...sh,
            players: sh.players.map(p => (p.id === playerId ? { ...p, ...partial } : p)),
          })),
        }));
        try {
          await apiFetch(`/shows/${showId}/players/${playerId}`, {
            method: 'PUT',
            body: JSON.stringify(partial),
          });
        } catch (err) {
          console.error('Failed to update player:', err);
        }
      },

      deletePlayer: async (showId, playerId) => {
        set(s => ({
          shows: patchShow(s.shows, showId, sh => ({
            ...sh,
            players: sh.players.filter(p => p.id !== playerId),
          })),
        }));
        try {
          await apiFetch(`/shows/${showId}/players/${playerId}`, { method: 'DELETE' });
        } catch (err) {
          console.error('Failed to delete player:', err);
        }
      },

      setCurrentAct: async (showId, act) => {
        set(s => ({
          shows: patchShow(s.shows, showId, sh => ({
            ...sh,
            micCheck: { ...sh.micCheck, currentAct: act },
          })),
        }));
        try {
          await apiFetch(`/shows/${showId}`, {
            method: 'PUT',
            body: JSON.stringify({ currentAct: act }),
          });
        } catch (err) {
          console.error('Failed to change act:', err);
        }
      },

      setChannelChecked: async (showId, act, channelKey, checked) => {
        // Optimistic — the Y/N keyboard flow depends on instant feedback.
        set(s => ({
          shows: patchShow(s.shows, showId, sh => {
            const actData = sh.micCheck.acts[act] || {};
            const existing = actData[channelKey] || { checked: false };
            return {
              ...sh,
              micCheck: {
                ...sh.micCheck,
                acts: {
                  ...sh.micCheck.acts,
                  [act]: {
                    ...actData,
                    [channelKey]: {
                      ...existing,
                      checked,
                      checkedAt: checked ? new Date().toISOString() : existing.checkedAt,
                    },
                  },
                },
              },
            };
          }),
        }));
        try {
          await apiFetch(`/shows/${showId}/check`, {
            method: 'PUT',
            body: JSON.stringify({ act, channelKey, checked }),
          });
        } catch (err) {
          console.error('Failed to save mic check:', err);
          set({ error: 'Mic check not saved — check the server connection' });
        }
      },

      setChannelNotes: async (showId, act, channelKey, notes) => {
        set(s => ({
          shows: patchShow(s.shows, showId, sh => {
            const actData = sh.micCheck.acts[act] || {};
            const existing = actData[channelKey] || { checked: false };
            return {
              ...sh,
              micCheck: {
                ...sh.micCheck,
                acts: { ...sh.micCheck.acts, [act]: { ...actData, [channelKey]: { ...existing, notes } } },
              },
            };
          }),
        }));
        try {
          await apiFetch(`/shows/${showId}/check`, {
            method: 'PUT',
            body: JSON.stringify({ act, channelKey, notes }),
          });
        } catch (err) {
          console.error('Failed to save note:', err);
        }
      },

      resetAct: async (showId, act) => {
        set(s => ({
          shows: patchShow(s.shows, showId, sh => {
            const acts = { ...sh.micCheck.acts };
            delete acts[act];
            return { ...sh, micCheck: { ...sh.micCheck, acts } };
          }),
        }));
        try {
          await apiFetch(`/shows/${showId}/acts/${act}`, { method: 'DELETE' });
        } catch (err) {
          console.error('Failed to reset act:', err);
        }
      },
    }),
    {
      name: 'rfdeck-shows-v3',
      // Show data itself is server-owned; only remember which show this
      // particular client had open.
      partialize: (state) => ({ activeShowId: state.activeShowId }) as any,
    }
  )
);

// ── One-time migration from the local-storage era ──
//
// Shows used to live entirely in `rfdeck-shows-v2`. Push any local records up
// to the server the first time this build runs, so real show data isn't lost.
// Deliberately non-destructive: the old key is left in place as a fallback.
const LEGACY_KEY = 'rfdeck-shows-v2';
const MIGRATED_FLAG = 'rfdeck-shows-migrated';

export async function migrateLegacyShows(): Promise<void> {
  if (localStorage.getItem(MIGRATED_FLAG)) return;

  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATED_FLAG, 'nothing-to-migrate');
    return;
  }

  try {
    const legacy = JSON.parse(raw)?.state?.shows;
    if (!Array.isArray(legacy) || legacy.length === 0) {
      localStorage.setItem(MIGRATED_FLAG, 'nothing-to-migrate');
      return;
    }

    // Only migrate into an empty server — never duplicate onto real data.
    const existing = await apiFetch<Show[]>('/shows');
    if (existing.length > 0) {
      localStorage.setItem(MIGRATED_FLAG, 'server-already-populated');
      return;
    }

    for (const old of legacy) {
      const created = await apiFetch<Show>('/shows', {
        method: 'POST',
        body: JSON.stringify({ name: old.name, environmentMode: old.environmentMode }),
      });

      for (const p of old.players ?? []) {
        await apiFetch(`/shows/${created.id}/players`, {
          method: 'POST',
          body: JSON.stringify({ realName: p.realName, characterName: p.characterName }),
        });
      }

      // Legacy entries were keyed by channel id. Those ids embed an IP that may
      // since have changed, but carrying them forward is strictly better than
      // dropping the ticks — a re-check under the new key repairs it.
      for (const [act, entries] of Object.entries(old.micCheck?.acts ?? {})) {
        for (const [key, entry] of Object.entries(entries as Record<string, any>)) {
          await apiFetch(`/shows/${created.id}/check`, {
            method: 'PUT',
            body: JSON.stringify({
              act: Number(act), channelKey: key,
              checked: entry.checked, notes: entry.notes,
            }),
          });
        }
      }
    }

    localStorage.setItem(MIGRATED_FLAG, new Date().toISOString());
    console.log(`[RFDeck] Migrated ${legacy.length} show(s) from local storage to the server`);
    await useShowStore.getState().fetchShows();
  } catch (err) {
    // Leave the flag unset so migration retries on the next load.
    console.error('[RFDeck] Show migration failed; local data left untouched:', err);
  }
}
