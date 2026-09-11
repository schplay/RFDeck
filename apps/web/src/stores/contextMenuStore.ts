import { create } from 'zustand';

// Which channel has a context menu open, and where.
//
// One menu for the whole dashboard rather than one per card: a hundred cards
// each carrying a menu component is a hundred sets of listeners for a thing
// that is open on at most one of them. The store says what is open; a single
// component renders it.

export interface OpenMenu {
  channelId: string;
  x: number;
  y: number;
}

interface ContextMenuStore {
  menu: OpenMenu | null;
  open: (channelId: string, x: number, y: number) => void;
  close: () => void;
}

export const useContextMenuStore = create<ContextMenuStore>()((set) => ({
  menu: null,
  open: (channelId, x, y) => set({ menu: { channelId, x, y } }),
  close: () => set({ menu: null }),
}));

/** An onContextMenu handler for anything that represents a channel. */
export function contextMenuFor(channelId: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    useContextMenuStore.getState().open(channelId, e.clientX, e.clientY);
  };
}
