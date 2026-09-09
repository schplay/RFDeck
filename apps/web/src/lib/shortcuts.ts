import { useEffect } from 'react';
import { create } from 'zustand';

// Keyboard shortcuts that describe themselves.
//
// RFDeck had three sets of them — Y/N and arrows in the mic check, 1-4 in
// Backstage, F/G on the Micboard — and no way to find out about any of them.
// They were written for an operator who already knew they were there, which in
// practice meant the person who wrote them.
//
// The fix is not a list of shortcuts kept somewhere else, because that list
// goes stale the first time a key changes and then actively misleads. A
// shortcut is declared once, here, with both what it does and what to call it,
// and the same declaration is what binds the handler. They cannot drift apart
// because they are the same object.

export interface Shortcut {
  /** How the key is written for a human: "Y", "1-4", "?". */
  keys: string;
  /** What it does, in the imperative: "Mark checked and move on". */
  label: string;
  /** Whether this event is this shortcut. */
  match: (e: KeyboardEvent) => boolean;
  /** What to do about it. */
  run: (e: KeyboardEvent) => void;
}

/** A named group of shortcuts, as it appears in the overlay. */
export interface ShortcutScope {
  scope: string;
  shortcuts: Array<Pick<Shortcut, 'keys' | 'label'>>;
}

interface ShortcutRegistry {
  /** Scopes currently mounted, in registration order. */
  scopes: ShortcutScope[];
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  register: (scope: string, shortcuts: Array<Pick<Shortcut, 'keys' | 'label'>>) => void;
  unregister: (scope: string) => void;
}

export const useShortcutRegistry = create<ShortcutRegistry>()((set) => ({
  scopes: [],
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  register: (scope, shortcuts) =>
    set((s) => ({ scopes: [...s.scopes.filter(x => x.scope !== scope), { scope, shortcuts }] })),
  unregister: (scope) =>
    set((s) => ({ scopes: s.scopes.filter(x => x.scope !== scope) })),
}));

/**
 * Is this keystroke meant for the page, or is someone typing?
 *
 * Centralised because it was not applied consistently: Backstage bound 1-4 with
 * no check at all, so typing a digit into any field on that page silently
 * changed the column layout. A shortcut that fires while someone is typing is
 * worse than no shortcut.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Bind a set of shortcuts, and publish them to the help overlay, for as long as
 * the component is mounted.
 *
 * @param scope What to call this group in the overlay — the view the operator
 *   is looking at, since that is how they will think about it.
 * @param enabled Bind nothing and advertise nothing while false, so a view can
 *   suspend its keys (a dialog is open, the surface is locked) without the
 *   overlay continuing to promise them.
 */
export function useShortcuts(scope: string, shortcuts: Shortcut[], enabled = true): void {
  const register = useShortcutRegistry(s => s.register);
  const unregister = useShortcutRegistry(s => s.unregister);

  useEffect(() => {
    if (!enabled) { unregister(scope); return; }

    register(scope, shortcuts.map(({ keys, label }) => ({ keys, label })));

    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      for (const s of shortcuts) {
        if (s.match(e)) { s.run(e); return; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      unregister(scope);
    };
    // Shortcuts close over view state, so the caller rebuilds the array when
    // that state changes and this rebinds with it.
  }, [scope, shortcuts, enabled, register, unregister]);
}

/**
 * Shorthand for the common case: one plain key, no modifiers.
 *
 * Modifiers are excluded deliberately — Ctrl+F and Cmd+R belong to the browser,
 * and a view that swallowed them would be taking something the operator relies
 * on more than anything RFDeck offers on the same key.
 */
export function plainKey(key: string): Shortcut['match'] {
  return (e) =>
    e.key.toLowerCase() === key.toLowerCase() && !e.ctrlKey && !e.metaKey && !e.altKey;
}
