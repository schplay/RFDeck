import { log } from '../logger';
import { CloudLink } from './link';
import { CloudLocalState, CloudOffline, CloudRefused, MerosClient, MerosSession, SignInCanceled } from './merosClient';
import { People, PersonSignIn, SignedIn } from './people';

/**
 * Signing in with Meros: meros.co's own sign-in page in a browser, then back to
 * RFDeck signed in. No codes.
 *
 * Two things sign in this way:
 *   • the **instance**, to link this RFDeck to a Meros account (`CloudLink`);
 *   • a **person**, so their preferences follow them (`People`).
 *
 * And two ways, by where RFDeck runs:
 *   • **RFDeck Desktop**, from the computer it runs on: the helper's loopback
 *     sign-in. It opens the system browser and waits on a 127.0.0.1 address
 *     for meros.co to come back, all in one call.
 *   • **Any browser reaching an RFDeck server**: `begin` pushes the request to
 *     meros.co and returns the page to send the browser to; meros.co sends the
 *     browser back to `/api/cloud/signin/callback` on the address it reached
 *     RFDeck at, and `finish` completes it there. The instance signs in with
 *     the RFDeck Server client, people with the RFDeck Browser client.
 *
 * The callback is bound to the browser that began it by a short-lived cookie
 * holding the state, so a sign-in begun by someone else can't be completed in
 * this browser, nor this browser's be completed in theirs.
 */

export type SignInPurpose = 'instance' | 'person';

/** How long a begun sign-in waits for its callback. The helper keeps it as long. */
const WAIT_MS = 10 * 60_000;
/** How long the loopback sign-in waits for the browser, as the helper's default. */
const LOOPBACK_S = 300;

/** A sign-in refused for a reason the person should be told, with its HTTP status. */
export class SignInError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

/** Where a finished redirect sign-in sends the browser, and what it carries. */
export interface Finished {
  purpose: SignInPurpose;
  returnTo: string;
  /** For a person: the code their page claims the sign-in with. */
  claim?: string;
}

export interface LoopbackAttempt {
  purpose: SignInPurpose;
  /** The page the helper opened, for an operator whose browser didn't open. */
  authorizeUrl: string | null;
}

interface Waiting {
  purpose: SignInPurpose;
  session: MerosSession;
  returnTo: string;
  persistent: boolean;
  expiresAt: number;
}

/** Turn a helper refusal into what the person is told. */
function explain(err: unknown): SignInError {
  if (err instanceof SignInError) return err;
  if (err instanceof SignInCanceled) return new SignInError(409, 'canceled', 'The sign-in was canceled.');
  if (err instanceof CloudOffline) {
    return new SignInError(502, 'meros_unreachable', 'Could not reach Meros. Check this computer’s internet connection and try again.');
  }
  if (err instanceof CloudLocalState && err.code === 'unknown_request') {
    return new SignInError(400, 'unknown_request', 'This sign-in expired or was already used. Sign in again.');
  }
  if (err instanceof CloudRefused) {
    switch (err.code) {
      case 'access_denied': return new SignInError(400, 'access_denied', 'The sign-in was canceled at meros.co.');
      case 'timeout': return new SignInError(408, 'timeout', 'The browser didn’t come back from meros.co in time. Sign in again.');
      case 'invalid_redirect_uri':
        return new SignInError(400, 'invalid_redirect_uri',
          'Meros won’t send a sign-in back to this address. Reach RFDeck by its local network name or address over https, or activate this server first.');
      default:
        return new SignInError(502, err.code ?? 'meros_refused', err.message);
    }
  }
  return new SignInError(500, 'sign_in_failed', (err as Error)?.message ?? 'The sign-in failed.');
}

/**
 * Where in the UI to come back to: a route of its hash router and nothing
 * else, so the callback can't be made to send a browser to another site.
 */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^#\/\S*$/.test(value) ? value : '#/';
}

export class SignIn {
  private waiting = new Map<string, Waiting>();
  private loopback: (LoopbackAttempt & { abort: AbortController }) | null = null;

  constructor(
    private readonly meros: MerosClient,
    private readonly link: CloudLink,
    private readonly people: People,
    /** RFDeck Desktop, which links through the loopback sign-in. */
    private readonly desktop: boolean,
  ) {}

  /**
   * Whether a request signs in through the loopback sign-in: RFDeck Desktop,
   * from the computer it runs on. Its window loads from disk and can't follow
   * a redirect back, and the loopback is what the desktop client is registered for.
   */
  usesLoopback(fromThisComputer: boolean): boolean {
    return this.desktop && fromThisComputer;
  }

  private sessionFor(purpose: SignInPurpose): MerosSession {
    if (purpose === 'instance') return this.link.session;
    if (!this.people.configured) {
      throw new SignInError(503, 'not_configured', 'Signing in to sync preferences isn’t configured on this server.');
    }
    return this.people.newSession();
  }

  /** The loopback sign-in in progress, if any. */
  get pendingLoopback(): LoopbackAttempt | null {
    return this.loopback ? { purpose: this.loopback.purpose, authorizeUrl: this.loopback.authorizeUrl } : null;
  }

  // ── RFDeck Desktop ────────────────────────────────────────────────────────

  /**
   * Sign in through the system browser and wait for it, up to five minutes.
   * One at a time: a second replaces the first.
   */
  async signInHere(purpose: SignInPurpose, persistent: boolean): Promise<PersonSignIn | null> {
    const session = this.sessionFor(purpose);
    this.cancel();
    const attempt = { purpose, authorizeUrl: null as string | null, abort: new AbortController() };
    this.loopback = attempt;
    try {
      const result = await this.meros.run<SignedIn>(
        'signin.browser.loopback', { timeout_s: LOOPBACK_S }, session,
        {
          timeoutMs: (LOOPBACK_S + 30) * 1000,
          signal: attempt.abort.signal,
          onStderrLine: line => {
            try {
              const url = JSON.parse(line)?.authorize_url;
              if (typeof url === 'string') attempt.authorizeUrl = url;
            } catch { /* not the line with the page */ }
          },
        },
      );
      return await this.completed(purpose, result, persistent);
    } catch (err) {
      throw explain(err);
    } finally {
      if (this.loopback === attempt) this.loopback = null;
    }
  }

  /** Stop the loopback sign-in in progress. */
  cancel(): boolean {
    if (!this.loopback) return false;
    this.loopback.abort.abort();
    this.loopback = null;
    return true;
  }

  // ── A browser reaching this server ────────────────────────────────────────

  /**
   * Push the sign-in to meros.co. Returns the page to send the browser to and
   * the state to set in its cookie.
   *
   * `redirectUri` is this server's callback on the address the browser used.
   */
  async begin(
    purpose: SignInPurpose,
    redirectUri: string,
    returnTo: string,
    persistent: boolean,
  ): Promise<{ authorizeUrl: string; state: string }> {
    if (purpose === 'instance' && this.desktop) {
      throw new SignInError(409, 'link_from_this_computer',
        'Link RFDeck Desktop to Meros from RFDeck on the computer it runs on.');
    }
    const session = this.sessionFor(purpose);
    const input: Record<string, unknown> = { redirect_uri: redirectUri };
    if (purpose === 'instance') {
      // The instance's own client, the only one Meros lets link a server.
      input.client = 'server';
      input.server_client_id = this.link.config.clientId;
    }
    let res: { authorize_url: string; state: string };
    try {
      res = await this.meros.run('signin.browser.begin', input, session);
    } catch (err) {
      throw explain(err);
    }
    const now = Date.now();
    for (const [state, w] of this.waiting) if (w.expiresAt < now) this.waiting.delete(state);
    this.waiting.set(res.state, { purpose, session, returnTo: safeReturnTo(returnTo), persistent, expiresAt: now + WAIT_MS });
    return { authorizeUrl: res.authorize_url, state: res.state };
  }

  /**
   * meros.co has sent the browser back. `cookieState` is the state cookie the
   * browser carried, which must be this sign-in's.
   */
  async finish(query: Record<string, string | undefined>, cookieState: string | undefined): Promise<Finished> {
    const state = query.state ?? '';
    const waiting = this.waiting.get(state);
    if (!waiting || waiting.expiresAt < Date.now()) {
      throw new SignInError(400, 'unknown_request', 'This sign-in expired or was already used. Sign in again.');
    }
    if (!cookieState || cookieState !== state) {
      // Left waiting, so the browser that did begin it can still finish.
      throw Object.assign(
        new SignInError(400, 'state_mismatch', 'This sign-in was begun in a different browser. Sign in again from this one.'),
        { returnTo: waiting.returnTo, purpose: waiting.purpose },
      );
    }
    this.waiting.delete(state);

    const input: Record<string, unknown> = { state };
    for (const key of ['code', 'iss', 'error', 'error_description'] as const) {
      if (query[key] !== undefined) input[key] = query[key];
    }
    try {
      const result = await this.meros.run<SignedIn>('signin.browser.finish', input, waiting.session);
      if (waiting.purpose === 'instance') {
        await this.link.linked();
        return { purpose: 'instance', returnTo: waiting.returnTo };
      }
      return { purpose: 'person', returnTo: waiting.returnTo, claim: this.people.hold(result, waiting.persistent) };
    } catch (err) {
      const reason = explain(err);
      log.warn(`[Cloud] Sign-in (${waiting.purpose}) refused: ${reason.code}`);
      throw Object.assign(reason, { returnTo: waiting.returnTo, purpose: waiting.purpose });
    }
  }

  private async completed(purpose: SignInPurpose, result: SignedIn, persistent: boolean): Promise<PersonSignIn | null> {
    if (purpose === 'instance') {
      await this.link.linked();
      return null;
    }
    return this.people.issue(result, persistent);
  }
}
