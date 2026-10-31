import { create } from 'zustand';
import {
  PersonSession, Person, loadSession, saveSession, claimSignIn, endPersonSession, PersonSignedOut,
} from '../lib/personLink';
import { signInWithMeros, cancelSignIn, pendingSignInPage, signInMessage } from '../lib/signIn';
import { syncProfile, pushProfile, SyncResult } from '../lib/profileSync';

/**
 * Who is signed in *in this browser*, and their synced preferences.
 *
 * Nothing here affects the rig. Everything works — or fails — without
 * changing what RFDeck does.
 */

interface PersonState {
  session: PersonSession | null;
  /** Signing in through the system browser (RFDeck Desktop), until it comes back. */
  waiting: boolean;
  /** The page the system browser was opened at, for when it didn't come up. */
  waitingPage: string | null;
  error: string | null;
  syncing: boolean;
  lastSync: SyncResult | null;

  /** Whether to keep the session past this tab — the person's call. */
  remember: boolean;
  setRemember: (remember: boolean) => void;
  signIn: () => Promise<void>;
  /** Finish a sign-in meros.co sent this page back from. */
  claim: (code: string) => Promise<void>;
  /** A sign-in that came back refused. */
  failed: (code: string) => void;
  cancel: () => Promise<void>;
  signOut: () => Promise<void>;
  sync: () => Promise<void>;
  pushNow: (keys?: string[]) => Promise<void>;
}

export const usePersonStore = create<PersonState>()((set, get) => {
  const signedIn = (session: PersonSession) => {
    saveSession(session);
    set({ session, waiting: false, waitingPage: null, error: null });
    // Reconcile preferences straight away: the reason someone signs in is to
    // get their own layout back.
    void get().sync();
  };

  const signedOutBy = (err: unknown) => {
    if (err instanceof PersonSignedOut) set({ session: null, error: err.message });
    else set({ error: (err as Error).message });
  };

  return {
    // Restored from storage, so a page reload doesn't sign someone out.
    session: loadSession(),
    waiting: false,
    waitingPage: null,
    error: null,
    syncing: false,
    lastSync: null,
    // Off by default: a venue PC is the common case, and a session that ends
    // with the tab is the safer default there. Somebody on their own laptop
    // ticks the box once.
    remember: loadSession()?.person.persistent ?? false,

    setRemember: remember => set({ remember }),

    signIn: async () => {
      set({ error: null, waiting: true, waitingPage: null });
      const watch = setInterval(() => {
        void pendingSignInPage().then(page => { if (get().waiting) set({ waitingPage: page }); });
      }, 1000);
      try {
        const result = await signInWithMeros('person', get().remember);
        if (result.redirected) return;
        signedIn({ token: result.token!, person: result.person as Person });
      } catch (err) {
        set({ waiting: false, waitingPage: null, error: (err as Error).message });
      } finally {
        clearInterval(watch);
      }
    },

    claim: async (code) => {
      try {
        signedIn(await claimSignIn(code));
      } catch (err) {
        set({ error: (err as Error).message });
      }
    },

    failed: (code) => set({ error: signInMessage(code) }),

    cancel: async () => {
      await cancelSignIn();
      set({ waiting: false, waitingPage: null });
    },

    signOut: async () => {
      const session = get().session;
      set({ session: null, lastSync: null, error: null });
      await endPersonSession(session);
    },

    sync: async () => {
      const session = get().session;
      if (!session) return;
      set({ syncing: true, error: null });
      try {
        set({ lastSync: await syncProfile(session) });
      } catch (err) {
        // A sync failure changes nothing about whether RFDeck works, so it is
        // reported and dropped rather than retried in a loop. A session that has
        // ended is cleared, so the menu offers sign-in again.
        signedOutBy(err);
      } finally {
        set({ syncing: false });
      }
    },

    pushNow: async (keys) => {
      const session = get().session;
      if (!session) return;
      try {
        await pushProfile(session, keys);
      } catch (err) {
        signedOutBy(err);
      }
    },
  };
});
