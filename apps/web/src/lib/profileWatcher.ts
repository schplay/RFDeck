import { useLayoutStore } from '../stores/layoutStore';
import { useMeterStore } from '../stores/meterStore';
import { useUiStore } from '../stores/uiStore';
import { usePersonStore } from '../stores/personStore';
import { markLocalChange } from './profileSync';

/**
 * Notice when a synced preference changes, stamp it, and push it.
 *
 * Deliberately outside the preference stores. `layoutStore` and friends should not
 * know that a cloud exists — they are about how this browser shows things, and
 * threading sync into each of them would put a network concern in three places and
 * make each one harder to reason about. Subscribing from here inverts that: sync
 * knows about preferences, preferences know nothing about sync.
 *
 * The stamp is the local half of last-write-wins. Without it, two machines editing
 * the same preference would be decided by whichever *synced* last rather than
 * whichever *changed* last — the wrong answer, and an unpredictable one.
 */

/**
 * Long enough that dragging cards around is one push rather than forty.
 *
 * Preferences are small and change in bursts — an operator reorders a dashboard,
 * or adjusts a meter, and then stops.
 */
const DEBOUNCE_MS = 3_000;

const WATCHED: Array<{ key: string; subscribe: (fn: () => void) => () => void }> = [
  { key: 'rfdeck-layout', subscribe: fn => useLayoutStore.subscribe(fn) },
  { key: 'rfdeck-meters', subscribe: fn => useMeterStore.subscribe(fn) },
  { key: 'rfdeck-ui', subscribe: fn => useUiStore.subscribe(fn) },
];

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = new Set<string>();

/** Start watching. Idempotent, so a re-render cannot double-subscribe. */
export function watchProfileChanges(): void {
  if (started) return;
  started = true;

  for (const { key, subscribe } of WATCHED) {
    subscribe(() => {
      // Stamped immediately, even when nobody is signed in: the timestamp is what
      // makes a later sign-in able to tell which side is newer, and a change made
      // before signing in is still the most recent one.
      markLocalChange(key);
      dirty.add(key);

      if (!usePersonStore.getState().session) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const keys = [...dirty];
        dirty = new Set();
        timer = null;
        // Fire and forget. A preference that fails to sync is not worth telling an
        // operator about mid-show, and the next change will carry it.
        void usePersonStore.getState().pushNow(keys);
      }, DEBOUNCE_MS);
    });
  }
}

/** Push anything pending now — on sign-out, or when a tab is closing. */
export function flushProfileChanges(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (dirty.size === 0) return;
  const keys = [...dirty];
  dirty = new Set();
  if (usePersonStore.getState().session) void usePersonStore.getState().pushNow(keys);
}
