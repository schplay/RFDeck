import { PersonSession, accessTokenFor } from './personLink';

/**
 * A person's preferences, following them between machines.
 *
 * Layout, meter settings, solo groups, shortcuts — the things that make RFDeck
 * feel like *your* RFDeck, which today live in `localStorage` and therefore stay
 * behind when an operator moves to another venue's rig.
 *
 * Last-write-wins **per key**, which is the property the whole feature rests on:
 * two machines editing different preferences must not clobber each other. Meros
 * merges partially — only the keys sent are touched, and a key sent as `null` is
 * removed — so the client never has to read-modify-write a whole document and
 * never races with itself.
 *
 * The local copy is always authoritative for *using* the application. Sync is a
 * convenience layered on top, so a failure here changes nothing about whether
 * RFDeck works.
 */

const NAMESPACE = 'rfdeck';

/** The stores worth carrying. Keyed by the `localStorage` key each one persists to. */
export const SYNCED_KEYS = [
  'rfdeck-layout',
  'rfdeck-meters',
  'rfdeck-ui',
] as const;

export interface RemoteProfile {
  namespace: string;
  keys: Record<string, unknown>;
  /** Per-key ISO timestamps, which is what makes the merge decidable. */
  key_meta: Record<string, string>;
  updated_at: string | null;
}

export class ProfileSyncError extends Error {}

async function call<T>(
  baseUrl: string,
  session: PersonSession,
  method: 'GET' | 'PUT' | 'DELETE',
  body?: unknown,
  clientId?: string,
  onRenewed?: (s: PersonSession) => void,
): Promise<T> {
  // Renewed here rather than by a timer, so a sync that happens after an hour
  // idle just works instead of failing and asking the operator to sign in again.
  const token = clientId
    ? await accessTokenFor(baseUrl, clientId, session, onRenewed ?? (() => {}))
    : session.accessToken;

  const res = await fetch(`${baseUrl}/v1/profiles/${NAMESPACE}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 413) {
    throw new ProfileSyncError(
      'Your saved preferences are too large to sync. Something is storing more than it should be.',
    );
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new ProfileSyncError(detail?.message ?? `Profile sync failed (HTTP ${res.status}).`);
  }
  return res.json();
}

/** What is stored locally, for the keys that are synced. */
export function readLocal(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SYNCED_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      out[key] = JSON.parse(raw);
    } catch {
      // Not JSON: carry it as a string rather than dropping a preference because
      // a store chose a different format.
      out[key] = raw;
    }
  }
  return out;
}

function writeLocal(keys: Record<string, unknown>) {
  for (const [key, value] of Object.entries(keys)) {
    if (!SYNCED_KEYS.includes(key as typeof SYNCED_KEYS[number])) continue;
    try {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch { /* quota or private browsing; the remote copy is unchanged */ }
  }
}

export interface SyncResult {
  pulled: string[];
  pushed: string[];
  /** Keys where both sides changed and the newer timestamp decided. */
  resolved: string[];
}

/**
 * Reconcile local and remote, per key.
 *
 * Called on sign-in. For each key: whichever side is newer wins, and a key that
 * exists on only one side is copied to the other. Per-key rather than
 * whole-document, because an operator who changed their meter settings here and
 * their layout there should end up with both — losing one of them is exactly the
 * outcome that makes people distrust sync.
 *
 * Local edit times come from a companion `…:at` key written by `markLocalChange`.
 * With no local timestamp the remote wins, on the grounds that the remote copy was
 * definitely written deliberately at some point, whereas an untimed local value may
 * only be a default.
 */
export async function syncProfile(
  baseUrl: string,
  session: PersonSession,
  clientId?: string,
  onRenewed?: (s: PersonSession) => void,
): Promise<SyncResult> {
  const remote = await call<RemoteProfile>(baseUrl, session, 'GET', undefined, clientId, onRenewed);
  const local = readLocal();
  const result: SyncResult = { pulled: [], pushed: [], resolved: [] };

  const toPush: Record<string, unknown> = {};
  const toPull: Record<string, unknown> = {};

  for (const key of SYNCED_KEYS) {
    const hasLocal = key in local;
    const hasRemote = remote.keys && key in remote.keys;

    if (hasLocal && !hasRemote) { toPush[key] = local[key]; result.pushed.push(key); continue; }
    if (!hasLocal && hasRemote) { toPull[key] = remote.keys[key]; result.pulled.push(key); continue; }
    if (!hasLocal && !hasRemote) continue;

    // Both sides have it. Identical content needs no decision at all, and making
    // one would produce a pointless write on every sign-in.
    if (JSON.stringify(local[key]) === JSON.stringify(remote.keys[key])) continue;

    const localAt = Number(localStorage.getItem(`${key}:at`) ?? 0);
    const remoteAt = Date.parse(remote.key_meta?.[key] ?? '') || 0;
    if (localAt > remoteAt) {
      toPush[key] = local[key];
    } else {
      toPull[key] = remote.keys[key];
    }
    result.resolved.push(key);
  }

  if (Object.keys(toPull).length > 0) writeLocal(toPull);
  if (Object.keys(toPush).length > 0) {
    // Partial merge: only these keys are touched, so a preference changed on
    // another machine in the same moment survives.
    await call(baseUrl, session, 'PUT', { keys: toPush }, clientId, onRenewed);
  }
  return result;
}

/** Push specific keys. Used after a local change, debounced by the caller. */
export async function pushProfile(
  baseUrl: string,
  session: PersonSession,
  keys: string[] = [...SYNCED_KEYS],
  clientId?: string,
  onRenewed?: (s: PersonSession) => void,
): Promise<void> {
  const local = readLocal();
  const payload: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in local) payload[key] = local[key];
  }
  if (Object.keys(payload).length === 0) return;
  await call(baseUrl, session, 'PUT', { keys: payload }, clientId, onRenewed);
}

/**
 * Record that a synced preference just changed here.
 *
 * The local half of last-write-wins. Without it, two machines editing the same
 * preference would be decided by whichever synced last rather than whichever
 * changed last — which is the wrong answer and an unpredictable one.
 */
export function markLocalChange(key: string) {
  try {
    localStorage.setItem(`${key}:at`, String(Date.now()));
  } catch { /* not worth failing a preference change over */ }
}
