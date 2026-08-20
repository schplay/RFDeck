import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Show, Player, MicCheckAct } from '@rfdeck/shared-types';

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface ShowStore {
  shows: Show[];
  activeShowId: string | null;

  createShow: (name: string, mode: Show['environmentMode']) => Show;
  deleteShow: (id: string) => void;
  setActiveShow: (id: string | null) => void;

  addPlayer: (showId: string, realName: string, characterName: string) => void;
  updatePlayer: (showId: string, playerId: string, partial: Partial<Omit<Player, 'id' | 'showId'>>) => void;
  deletePlayer: (showId: string, playerId: string) => void;

  setCurrentAct: (showId: string, act: MicCheckAct) => void;
  setChannelChecked: (showId: string, act: MicCheckAct, channelId: string, checked: boolean) => void;
  setChannelNotes: (showId: string, act: MicCheckAct, channelId: string, notes: string) => void;
  resetAct: (showId: string, act: MicCheckAct) => void;
}

export const useShowStore = create<ShowStore>()(
  persist(
    (set) => ({
      shows: [],
      activeShowId: null,

      createShow: (name, mode) => {
        const now = new Date().toISOString();
        const show: Show = {
          id: uuid(),
          name,
          environmentMode: mode,
          players: [],
          micCheck: { currentAct: 1, acts: {} },
          createdAt: now,
          updatedAt: now,
        };
        set(s => ({ shows: [...s.shows, show] }));
        return show;
      },

      deleteShow: (id) => {
        set(s => ({
          shows: s.shows.filter(sh => sh.id !== id),
          activeShowId: s.activeShowId === id ? null : s.activeShowId,
        }));
      },

      setActiveShow: (id) => set({ activeShowId: id }),

      addPlayer: (showId, realName, characterName) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            const player: Player = {
              id: uuid(),
              showId,
              realName,
              characterName,
              notes: '',
              assignedChannelId: null,
            };
            return { ...sh, players: [...sh.players, player], updatedAt: new Date().toISOString() };
          }),
        }));
      },

      updatePlayer: (showId, playerId, partial) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            return {
              ...sh,
              players: sh.players.map(p => p.id === playerId ? { ...p, ...partial } : p),
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      deletePlayer: (showId, playerId) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            return {
              ...sh,
              players: sh.players.filter(p => p.id !== playerId),
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      setCurrentAct: (showId, act) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            return {
              ...sh,
              micCheck: { ...sh.micCheck, currentAct: act },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      setChannelChecked: (showId, act, channelId, checked) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            const actData = sh.micCheck.acts[act] || {};
            const existing = actData[channelId] || {};
            return {
              ...sh,
              micCheck: {
                ...sh.micCheck,
                acts: {
                  ...sh.micCheck.acts,
                  [act]: {
                    ...actData,
                    [channelId]: {
                      ...existing,
                      checked,
                      checkedAt: checked ? new Date().toISOString() : existing.checkedAt,
                    },
                  },
                },
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      setChannelNotes: (showId, act, channelId, notes) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            const actData = sh.micCheck.acts[act] || {};
            const existing = actData[channelId] || { checked: false };
            return {
              ...sh,
              micCheck: {
                ...sh.micCheck,
                acts: {
                  ...sh.micCheck.acts,
                  [act]: {
                    ...actData,
                    [channelId]: { ...existing, notes },
                  },
                },
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      resetAct: (showId, act) => {
        set(s => ({
          shows: s.shows.map(sh => {
            if (sh.id !== showId) return sh;
            const newActs = { ...sh.micCheck.acts };
            delete newActs[act];
            return {
              ...sh,
              micCheck: { ...sh.micCheck, acts: newActs },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },
    }),
    {
      name: 'rfdeck-shows-v2',
    }
  )
);
