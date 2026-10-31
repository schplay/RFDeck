import { apiFetch } from './api';

/**
 * Signing in with Meros, from the UI: meros.co's own sign-in page, then back
 * to RFDeck signed in. No codes.
 *
 * The server decides how. From RFDeck Desktop on its own computer it opens
 * the system browser and the call waits until the person comes back to it;
 * from any other browser it answers with the meros.co page, this page goes
 * there, and meros.co sends it back with the outcome in the address (read by
 * `takeSignInReturn`).
 */

export type SignInPurpose = 'instance' | 'person';

export type SignInResult =
  | { redirected: true }
  | { redirected: false; token?: string; person?: unknown };

/** What the operator is told for each way a sign-in can fail. */
const MESSAGES: Record<string, string> = {
  access_denied: 'The sign-in was canceled at meros.co.',
  canceled: 'The sign-in was canceled.',
  unknown_request: 'This sign-in expired or was already used. Sign in again.',
  state_mismatch: 'This sign-in was begun in a different browser. Sign in again from this one.',
  invalid_redirect_uri:
    'Meros won’t send a sign-in back to this address. Reach RFDeck by its local network name or address over https, or activate this server first.',
  meros_unreachable: 'Could not reach Meros. Check this computer’s internet connection and try again.',
  timeout: 'The browser didn’t come back from meros.co in time. Sign in again.',
  not_configured: 'Meros Cloud is not configured on this server.',
};

export function signInMessage(code: string): string {
  return MESSAGES[code] ?? `The sign-in didn’t complete (${code}).`;
}

/**
 * Sign in. Resolves `{redirected: true}` when this page is on its way to
 * meros.co, or with the outcome when the sign-in happened in the system browser.
 */
export async function signInWithMeros(purpose: SignInPurpose, remember = false): Promise<SignInResult> {
  const res = await apiFetch<{ redirect?: string; token?: string; person?: unknown }>('/cloud/signin', {
    method: 'POST',
    body: JSON.stringify({ purpose, remember, returnTo: window.location.hash || '#/' }),
  });
  if (res.redirect) {
    window.location.assign(res.redirect);
    return { redirected: true };
  }
  return { redirected: false, token: res.token, person: res.person };
}

/** The page the system browser was opened at, while RFDeck Desktop waits on it. */
export async function pendingSignInPage(): Promise<string | null> {
  try {
    const res = await apiFetch<{ pending: { authorizeUrl: string | null } | null }>('/cloud/signin');
    return res.pending?.authorizeUrl ?? null;
  } catch {
    return null;
  }
}

export async function cancelSignIn(): Promise<void> {
  try { await apiFetch('/cloud/signin/cancel', { method: 'POST' }); } catch { /* nothing to stop */ }
}

export interface SignInReturn {
  /** `linked`, `person`, or null when it failed. */
  outcome: 'linked' | 'person' | null;
  claim: string | null;
  error: string | null;
  /** Which sign-in failed, when one did. */
  errorFor: SignInPurpose | null;
}

/**
 * What meros.co came back with, if this page load is the return from a
 * sign-in. Read once: the address is cleaned so a reload or a bookmark
 * doesn't replay it.
 */
export function takeSignInReturn(): SignInReturn | null {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('signin');
  const error = params.get('signin_error');
  if (!outcome && !error) return null;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  const errorFor = params.get('signin_for');
  return {
    outcome: outcome === 'linked' || outcome === 'person' ? outcome : null,
    claim: params.get('claim'),
    error,
    errorFor: errorFor === 'instance' || errorFor === 'person' ? errorFor : null,
  };
}
