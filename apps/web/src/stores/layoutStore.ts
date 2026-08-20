import { useMemo, useRef, useState, useLayoutEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Channel } from '@rfdeck/shared-types';
import { channelKey } from '../lib/channelKey';

export type OrderMode = 'alpha' | 'custom';

// Custom ordering uses the shared stable channel key — see lib/channelKey.
// Re-exported under the old name so existing call sites keep working.
export const orderKey = channelKey;

interface LayoutStore {
  orderMode: OrderMode;
  customOrder: string[]; // orderKeys in display order
  backstageCols: number; // column count on the backstage view (1-4)
  setOrderMode: (mode: OrderMode) => void;
  setCustomOrder: (keys: string[]) => void;
  setBackstageCols: (cols: number) => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      orderMode: 'alpha',
      customOrder: [],
      backstageCols: 2,
      setOrderMode: (orderMode) => set({ orderMode }),
      setCustomOrder: (customOrder) => set({ customOrder }),
      setBackstageCols: (backstageCols) => set({ backstageCols }),
    }),
    { name: 'rfdeck-layout' }
  )
);

export function sortChannels(channels: Channel[], mode: OrderMode, customOrder: string[]): Channel[] {
  const alpha = (a: Channel, b: Channel) => (a.name || '').localeCompare(b.name || '');
  if (mode !== 'custom' || customOrder.length === 0) {
    return [...channels].sort(alpha);
  }
  const idx = new Map(customOrder.map((k, i) => [k, i]));
  return [...channels].sort((a, b) => {
    const ia = idx.get(orderKey(a));
    const ib = idx.get(orderKey(b));
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1; // known keys before unknown
    if (ib !== undefined) return 1;
    return alpha(a, b); // channels not yet in the custom order append alphabetically
  });
}

// Returns channels in the active display order (custom or alphabetical).
export function useOrderedChannels(channels: Channel[]): Channel[] {
  const orderMode = useLayoutStore((s) => s.orderMode);
  const customOrder = useLayoutStore((s) => s.customOrder);
  return useMemo(
    () => sortChannels(channels, orderMode, customOrder),
    [channels, orderMode, customOrder]
  );
}

// HTML5 drag-and-drop reordering with live preview: cards reorder as the drag
// passes over them (dragEnter) so the user always sees where the card will land.
// Spread `handlers(ch)` onto each card wrapper; combine with useFlipAnimation
// for smooth position transitions. Only active in custom mode.
export function useDragReorder(orderedChannels: Channel[]) {
  const orderMode = useLayoutStore((s) => s.orderMode);
  const setCustomOrder = useLayoutStore((s) => s.setCustomOrder);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const lastSwapAt = useRef(0);
  const enabled = orderMode === 'custom';

  const moveBefore = (fromKey: string, toKey: string) => {
    // Throttle: dragEnter can fire in rapid bursts as the layout shifts under
    // the cursor; without this the same pair can oscillate.
    const now = Date.now();
    if (now - lastSwapAt.current < 120) return;
    // Rebuild the full key list from what's currently displayed so that
    // channels never seen before become part of the saved order.
    const keys = orderedChannels.map(orderKey);
    const fromIdx = keys.indexOf(fromKey);
    const toIdx = keys.indexOf(toKey);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    keys.splice(fromIdx, 1);
    keys.splice(toIdx, 0, fromKey);
    lastSwapAt.current = now;
    setCustomOrder(keys);
  };

  const handlers = (ch: Channel): React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean } => {
    if (!enabled) return {};
    const key = orderKey(ch);
    const isDragging = draggingKey === key;
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        setDraggingKey(key);
      },
      // Live reorder: as the dragged card enters another card's bounds, commit
      // the new order immediately so the layout previews the final result.
      onDragEnter: () => {
        if (draggingKey && draggingKey !== key) moveBefore(draggingKey, key);
      },
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDraggingKey(null);
      },
      onDragEnd: () => setDraggingKey(null),
      style: {
        cursor: 'grab',
        opacity: isDragging ? 0.35 : undefined,
        transition: 'opacity 0.15s',
      } as React.CSSProperties,
    };
  };

  return { enabled, handlers, draggingKey };
}

// FLIP animation: when the display ORDER changes, cards glide from their old
// position to the new one instead of snapping. Attach `setFlipRef(ch.id)` as
// the `ref` of the same element that receives the drag handlers, and pass the
// current order signature (joined channel ids) so animation only triggers on
// actual reorders — never on telemetry re-renders or scrolling.
export function useFlipAnimation(orderSignature: string) {
  const elements = useRef(new Map<string, HTMLElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const prevSignature = useRef<string | null>(null);

  useLayoutEffect(() => {
    const orderChanged =
      prevSignature.current !== null && prevSignature.current !== orderSignature;
    prevSignature.current = orderSignature;

    const nextRects = new Map<string, DOMRect>();
    for (const [key, el] of elements.current) {
      const rect = el.getBoundingClientRect();
      nextRects.set(key, rect);
      if (orderChanged) {
        const prev = prevRects.current.get(key);
        if (prev) {
          const dx = prev.left - rect.left;
          const dy = prev.top - rect.top;
          if (dx !== 0 || dy !== 0) {
            el.animate(
              [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
              { duration: 220, easing: 'cubic-bezier(0.2, 0, 0.2, 1)' }
            );
          }
        }
      }
    }
    prevRects.current = nextRects;
  });

  // Key by a UNIQUE id (channel id), not orderKey — channel names can collide,
  // which would make two cards fight over one map slot and thrash animations.
  const setFlipRef = (key: string) => (el: HTMLElement | null) => {
    if (el) elements.current.set(key, el);
    else elements.current.delete(key);
  };

  return setFlipRef;
}
