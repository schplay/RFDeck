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
 * Two deliberate choices about where tokens live:
 *
 *   • They stay in this tab and never reach the RFDeck server. A venue machine is
 *     shared, and a personal token on it would outlive the person using it.
 *   • No `offline_access`, so there is no refresh token to leak or to rotate.
 *     The access token lasts an hour and then sign-in is offered again. On a
 *     machine several people touch, that is the right trade rather than a
 *     limitation.
 *
 * The RFDeck Browser client is its own OAuth client, so refresh families — which
 * are scoped to (user, client) — can never make this link and the server's
 * instance link revoke each other.
 */

export interface PersonSession {
  accessToken: string;
  expiresAt: number;
  /** The stable, opaque Meros user id. The join key; email is not. */
  sub: string;
  email: string | null;
  name: string | null;
}

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  intervalMs: number;
}

const SCOPES = 'openid profile email profiles:read profiles:write';

/** Session storage, not local: closing the tab ends it, which is the point. */
const STORAGE_KEY = 'rfdeck.person';

export function loadSession(): PersonSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as PersonSession;
    // An expired token is not a session. Treating it as one would show a signed-in
    // account menu whose every request fails.
    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session: PersonSession | null) {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* private browsing; the session is simply not remembered */ }
}

interface Discovery {
  device_authorization_endpoint?: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  revocation_endpoint?: string;
}

async function discover(baseUrl: string): Promise<Discovery> {
  const res = await fetch(`${baseUrl}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Meros did not answer discovery (HTTP ${res.status}).`);
  return res.json();
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
  } catch (err) {
    // The venue's uplink, most likely, while the operator approves on a phone.
    // Keep waiting rather than giving up.
    return { state: 'pending' };
  }

  // Identity from /userinfo rather than by decoding the id_token: verifying a JWT
  // properly means fetching JWKS and checking a signature, and there is no reason
  // to do that in a browser when an authenticated endpoint will simply tell us.
  let sub = '';
  let email: string | null = null;
  let name: string | null = null;
  if (doc.userinfo_endpoint) {
    try {
      const who = await fetch(doc.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${body.access_token}` },
      });
      if (who.ok) {
        const info = await who.json();
        sub = typeof info.sub === 'string' ? info.sub : '';
        email = typeof info.email === 'string' ? info.email : null;
        name = typeof info.name === 'string' ? info.name : null;
      }
    } catch { /* the token still works; the display name is a nicety */ }
  }
  if (!sub) {
    return {
      state: 'error',
      message: 'Signed in, but Meros did not say who — cannot link a profile without an identity.',
    };
  }

  const session: PersonSession = {
    accessToken: body.access_token,
    expiresAt: Date.now() + Math.max(30, (body.expires_in ?? 3600) - 60) * 1000,
    sub, email, name,
  };
  saveSession(session);
  return { state: 'linked', session };
}

/** Sign out. Revokes at Meros where it can, and always forgets locally. */
export async function endPersonLink(baseUrl: string, clientId: string, session: PersonSession | null) {
  saveSession(null);
  if (!session) return;
  try {
    const doc = await discover(baseUrl);
    if (doc.revocation_endpoint) {
      await fetch(doc.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: session.accessToken, client_id: clientId }),
      });
    }
  } catch {
    // Forgetting locally is what the operator asked for; the token expires within
    // the hour regardless.
  }
}
