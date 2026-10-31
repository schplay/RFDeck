import { apiFetch } from './api';

/**
 * Who is signed in to Meros in this browser, to sync their preferences.
 *
 * The person signs in on meros.co's own sign-in page (see `signIn.ts`). Their
 * Meros session is kept by the RFDeck server, so their tokens never sit in a
 * browser; this browser keeps only the token that says which person it is,
 * sent as `x-rfdeck-person`.
 *
 * Where it keeps it decides how long the sign-in lasts here:
 *
 *   • **Default: this tab only.** `sessionStorage`, so it ends when the tab
 *     closes. A venue PC doesn't collect identities.
 *   • **"Keep me signed in": this machine.** `localStorage`, for somebody's own
 *     laptop. Their choice, because they know which kind of machine they are on
 *     and RFDeck doesn't.
 */

export interface Person {
  /** The stable, opaque Meros user id. The join key; email is not. */
  sub: string;
  name: string | null;
  email: string | null;
  /** Kept on this machine rather than for the tab. */
  persistent: boolean;
}

export interface PersonSession {
  token: string;
  person: Person;
}

const STORAGE_KEY = 'rfdeck.person';

export function loadSession(): PersonSession | null {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) continue;
      const session = JSON.parse(raw) as PersonSession;
      if (typeof session?.token === 'string' && session.person?.sub) return session;
      store.removeItem(STORAGE_KEY);
    } catch { /* unreadable; treat as absent */ }
  }
  return null;
}

export function saveSession(session: PersonSession | null) {
  try {
    // Written to exactly one store, and cleared from both, so toggling "keep me
    // signed in" can't leave a stale copy behind in the other.
    sessionStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    if (!session) return;
    const store = session.person.persistent ? localStorage : sessionStorage;
    store.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch { /* private browsing; the session is simply not remembered */ }
}

/** Thrown when the session is over and only signing in again will do. */
export class PersonSignedOut extends Error {
  constructor(message = 'Your Meros session ended. Sign in again to sync preferences.') {
    super(message);
    this.name = 'PersonSignedOut';
  }
}

/** Call the server as the person signed in here. */
export async function asPerson<T>(session: PersonSession, path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await apiFetch<T>(path, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-rfdeck-person': session.token },
    });
  } catch (err) {
    // The PIN is a different 401, handled by apiFetch itself.
    if ((err as { status?: number }).status === 401 && (err as { code?: string }).code !== 'PIN_REQUIRED') {
      saveSession(null);
      throw new PersonSignedOut();
    }
    throw err;
  }
}

/** Exchange the code a redirect sign-in came back with for this browser's token. */
export async function claimSignIn(code: string): Promise<PersonSession> {
  const session = await apiFetch<PersonSession>('/cloud/me/claim', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  saveSession(session);
  return session;
}

/** Sign out, here and at Meros. Always forgets locally. */
export async function endPersonSession(session: PersonSession | null) {
  saveSession(null);
  if (!session) return;
  try {
    await asPerson(session, '/cloud/me/signout', { method: 'POST' });
  } catch {
    // Forgetting locally is what the person asked for.
  }
}
