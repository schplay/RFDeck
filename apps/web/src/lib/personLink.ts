/**
 * The person link: a device grant, run in the browser.
 *
 * Not the ordinary auth-code redirect, for a reason specific to RFDeck. The UI is
 * served by the venue's own server and an operator reaches it from a phone or a
 * laptop at something like `http://192.168.1.50:3000` — DHCP-assigned, different
 * at every venue, impossible to pre-register as a redirect URI. So there is
 * nowhere for a redirect to come back to.
 *
 * The device grant needs no redirect at all: the page shows a code, the operator
 * approves it on their phone, and **this browser** polls the token endpoint. Meros
 * CORS-enables the device, token, userinfo and revoke endpoints for exactly this.
 *
 * ── Signing in happens once ──────────────────────────────────────────────────
 *
 * `offline_access` is requested and the refresh token is kept, so the session
 * renews itself silently. An earlier version of this deliberately went without,
 * reasoning that a shared venue machine should hold nothing personal — but the
 * consequence was re-approving with a phone and a typed code every hour, which is
 * not a trade, it is a broken feature. Getting your phone out mid-show because an
 * access token lapsed is exactly the kind of thing that makes people stop using
 * something.
 *
 * The shared-machine concern is real and is handled by *where* the token lives
 * rather than by not having one:
 *
 *   • **Default — this tab only.** `sessionStorage`, so the session ends when the
 *     tab closes. A venue PC does not accumulate identities, and the operator
 *     signs in once per sitting rather than once per hour.
 *   • **"Keep me signed in" — this machine.** `localStorage`, for somebody's own
 *     laptop. Their choice, because they know which kind of machine they are on
 *     and RFDeck does not.
 *
 * Tokens still never reach the RFDeck server either way.
 */

export interface PersonSession {
  accessToken: string;
  /** Present because `offline_access` is requested; renews the session silently. */
  refreshToken: string | null;
  expiresAt: number;
  /** The stable, opaque Meros user id. The join key; email is not. */
  sub: string;
  email: string | null;
  name: string | null;
  /** Where this session is stored, and therefore how long it lasts. */
  persistent: boolean;
}

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  intervalMs: number;
}

const SCOPES = 'openid profile email offline_access profiles:read profiles:write';

const STORAGE_KEY = 'rfdeck.person';
/**
 * A cross-tab lock, because refresh tokens rotate and a replay is a breach.
 *
 * With "keep me signed in" the token is in `localStorage` and every tab can see
 * it. Two tabs refreshing at once would present the same token, and Meros treats
 * the second as a replay and revokes the **whole** (user, client) family — so both
 * tabs would be signed out, deliberately, as a breach response. One tab refreshes
 * and the others read the result.
 */
const LOCK_KEY = 'rfdeck.person.refreshing';
const LOCK_TTL_MS = 10_000;

export function loadSession(): PersonSession | null {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) continue;
      const session = JSON.parse(raw) as PersonSession;
      // An expired access token is not a dead session any more — there is a
      // refresh token to renew it with. Only a session with neither is gone.
      if (session.expiresAt > Date.now() || session.refreshToken) return session;
      store.removeItem(STORAGE_KEY);
    } catch { /* unreadable; treat as absent */ }
  }
  return null;
}

export function saveSession(session: PersonSession | null) {
  try {
    // Written to exactly one store, and cleared from both — so toggling "keep me
    // signed in" cannot leave a stale copy behind in the other.
    sessionStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    if (!session) return;
    const store = session.persistent ? localStorage : sessionStorage;
    store.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch { /* private browsing; the session is simply not remembered */ }
}

interface Discovery {
  device_authorization_endpoint?: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  revocation_endpoint?: string;
}

let discoveryCache: { at: number; doc: Discovery } | null = null;

async function discover(baseUrl: string): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < 60 * 60_000) return discoveryCache.doc;
  const res = await fetch(`${baseUrl}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Meros did not answer discovery (HTTP ${res.status}).`);
  const doc = await res.json();
  discoveryCache = { at: Date.now(), doc };
  return doc;
}

/** Begin the flow. Returns the code to show the operator. */
export async function startPersonLink(baseUrl: string, clientId: string): Promise<DeviceCodeStart> {
  const doc = await discover(baseUrl);
  if (!doc.device_authorization_endpoint) {
    throw new Error('Meros does not offer the device grant, so signing in from here is not possible.');
  }
  const res = await fetch(doc.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }),
  });
  if (!res.ok) throw new Error(`Could not start sign-in (HTTP ${res.status}).`);
  const body = await res.json();
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete ?? null,
    expiresAt: Date.now() + Math.max(60, body.expires_in ?? 600) * 1000,
    // RFC 8628 §3.2: absent means five seconds.
    intervalMs: Math.max(1, body.interval ?? 5) * 1000,
  };
}

export type PollOutcome =
  | { state: 'pending' }
  | { state: 'slow_down'; intervalMs: number }
  | { state: 'linked'; session: PersonSession }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'error'; message: string };

/** Identity from `/userinfo`, which is simpler than verifying a JWT in a browser. */
async function whoIs(doc: Discovery, accessToken: string) {
  let sub = '', email: string | null = null, name: string | null = null;
  if (!doc.userinfo_endpoint) return { sub, email, name };
  try {
    const res = await fetch(doc.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const info = await res.json();
      sub = typeof info.sub === 'string' ? info.sub : '';
      email = typeof info.email === 'string' ? info.email : null;
      name = typeof info.name === 'string' ? info.name : null;
    }
  } catch { /* the token works; the display name is a nicety */ }
  return { sub, email, name };
}

function sessionFrom(
  body: any,
  who: { sub: string; email: string | null; name: string | null },
  persistent: boolean,
): PersonSession {
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    // A minute of headroom, so a request never starts with a token about to lapse.
    expiresAt: Date.now() + Math.max(30, (body.expires_in ?? 3600) - 60) * 1000,
    sub: who.sub, email: who.email, name: who.name,
    persistent,
  };
}

/**
 * Ask once whether it has been approved.
 *
 * One poll per call, so the caller owns the interval — `slow_down` has to be able
 * to change it, and a fixed loop in here could not honour that.
 */
export async function pollPersonLink(
  baseUrl: string,
  clientId: string,
  deviceCode: string,
  intervalMs: number,
  persistent: boolean,
): Promise<PollOutcome> {
  let doc: Discovery;
  try {
    doc = await discover(baseUrl);
  } catch (err) {
    return { state: 'error', message: (err as Error).message };
  }

  let body: any;
  try {
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: clientId,
      }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) {
      switch (body?.error) {
        case 'authorization_pending': return { state: 'pending' };
        case 'slow_down': return { state: 'slow_down', intervalMs: intervalMs + 5_000 };
        case 'access_denied': return { state: 'denied' };
        case 'expired_token': return { state: 'expired' };
        default: return { state: 'error', message: body?.error_description ?? body?.error ?? `HTTP ${res.status}` };
      }
    }
  } catch {
    // The venue's uplink, most likely, while the operator approves on a phone.
    // Keep waiting rather than giving up.
    return { state: 'pending' };
  }

  const who = await whoIs(doc, body.access_token);
  if (!who.sub) {
    return {
      state: 'error',
      message: 'Signed in, but Meros did not say who — cannot link a profile without an identity.',
    };
  }
  const session = sessionFrom(body, who, persistent);
  saveSession(session);
  return { state: 'linked', session };
}

/** Thrown when the session is genuinely over and only signing in again will do. */
export class PersonSignedOut extends Error {
  constructor(message = 'Your Meros session ended. Sign in again to sync preferences.') {
    super(message);
    this.name = 'PersonSignedOut';
  }
}

function lockHeldElsewhere(): boolean {
  try {
    const at = Number(localStorage.getItem(LOCK_KEY) ?? 0);
    return Number.isFinite(at) && Date.now() - at < LOCK_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * A usable access token, renewing silently if it is due.
 *
 * This is what makes signing in a once-per-sitting act rather than an hourly
 * interruption. Two properties are worth being explicit about, both learned from
 * the server-side link:
 *
 *   • **The rotated refresh token is stored before the new access token is
 *     returned.** Meros rotates on use, and a replay revokes the whole family —
 *     so if the tab were closed between receiving and storing, the next attempt
 *     would present a dead token and the session really would be gone.
 *   • **Only one tab refreshes at a time**, when the token is shared via
 *     `localStorage`. Two at once would look exactly like a replay.
 */
export async function accessTokenFor(
  baseUrl: string,
  clientId: string,
  session: PersonSession,
  onRenewed: (session: PersonSession) => void,
): Promise<string> {
  if (session.expiresAt > Date.now()) return session.accessToken;
  if (!session.refreshToken) throw new PersonSignedOut();

  // Another tab is already renewing. Wait for it and use what it stored, rather
  // than presenting the same refresh token in parallel.
  if (session.persistent && lockHeldElsewhere()) {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const fresh = loadSession();
      if (fresh && fresh.accessToken !== session.accessToken && fresh.expiresAt > Date.now()) {
        onRenewed(fresh);
        return fresh.accessToken;
      }
      if (!lockHeldElsewhere()) break;
    }
  }

  try {
    if (session.persistent) localStorage.setItem(LOCK_KEY, String(Date.now()));
  } catch { /* lock is best-effort */ }

  try {
    const doc = await discover(baseUrl);
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: clientId,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // `invalid_grant` means the token is gone: rotated and replayed, revoked at
      // Meros, or the family was killed. Retrying cannot help, so the session is
      // ended cleanly rather than looped over.
      saveSession(null);
      throw new PersonSignedOut(
        body?.error === 'invalid_grant'
          ? 'Your Meros session ended. Sign in again to sync preferences.'
          : `Could not renew the Meros session (${body?.error ?? res.status}).`,
      );
    }
    const renewed = sessionFrom(
      body,
      { sub: session.sub, email: session.email, name: session.name },
      session.persistent,
    );
    // Stored before it is used, always.
    saveSession(renewed);
    onRenewed(renewed);
    return renewed.accessToken;
  } finally {
    try { localStorage.removeItem(LOCK_KEY); } catch { /* ignore */ }
  }
}

/** Sign out. Revokes at Meros where it can, and always forgets locally. */
export async function endPersonLink(baseUrl: string, clientId: string, session: PersonSession | null) {
  saveSession(null);
  if (!session) return;
  try {
    const doc = await discover(baseUrl);
    if (doc.revocation_endpoint) {
      // Revoking the refresh token takes its whole lineage with it, which is what
      // "sign out" should mean.
      await fetch(doc.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: session.refreshToken ?? session.accessToken,
          client_id: clientId,
          ...(session.refreshToken ? { token_type_hint: 'refresh_token' } : {}),
        }),
      });
    }
  } catch {
    // Forgetting locally is what the operator asked for; the token lapses anyway.
  }
}
