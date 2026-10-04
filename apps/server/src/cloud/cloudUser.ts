import crypto from 'crypto';
import { log } from '../logger';
import { CloudClient, CloudOffline, CloudRefused } from './client';
import { CloudConfig, CLOUD_USER_SCOPES } from './config';
import { CloudUserStore } from './cloudUserStore';
import { TokenResponse } from './types';

/**
 * Signing a Meros cloud user in on this install, from Manifold.
 *
 * The operator signs in to Meros once, on the console. Manifold then asks Meros
 * for a single-use **login token** for RFDeck and hands it to this server, which
 * redeems it at Meros as RFDeck's own client — "RFDeck Cloud User" — and gets
 * RFDeck's own tokens, exactly as if the user had signed in here directly. The
 * login token carries no permissions; RFDeck asks for its own scopes when it
 * redeems. Contract: meros.co `docs/handoff/manifold-integration.md` §5.
 *
 * ── Why the begin/complete pair ──────────────────────────────────────────────
 *
 * The login token redeems into a **one-year refresh token**, it travels through
 * Manifold, and RFDeck's client is public, so there is no secret RFDeck could
 * prove at redeem time that Manifold could not also prove. PKCE closes that, but
 * only if *RFDeck* makes the verifier. So:
 *
 *   1. `begin` — RFDeck makes the verifier V and a nonce, keeps V, and gives
 *      Manifold the challenge `base64url(SHA-256(V))` and the nonce.
 *   2. Manifold mints the login token at Meros with that challenge and nonce.
 *   3. `complete` — Manifold hands back the login token; RFDeck redeems it with V.
 *
 * Manifold never sees V, so a login token lifted off the wire, or kept by
 * Manifold, cannot be redeemed by anyone else. The nonce comes back in the
 * id_token, which ties the identity RFDeck records to this particular sign-in.
 *
 * ── The refresh family ───────────────────────────────────────────────────────
 *
 * Same rules as the instance link (`link.ts`): the rotated refresh token is stored
 * before the access token is used, concurrent callers share one refresh, and
 * `invalid_grant` on refresh means "signed out" rather than "retry". It is a
 * separate family from the instance link's, under a separate client, so neither
 * can revoke the other.
 *
 * A cloud logout on Manifold does not sign RFDeck out: RFDeck holds its own
 * tokens, and only signing out here, or Meros refusing the refresh, ends it.
 */

/** How long a begun sign-in waits for Manifold to come back with a login token. */
const PENDING_TTL_MS = 5 * 60_000;
/** A ceiling on begun-but-unfinished sign-ins, so `begin` cannot grow memory. */
const MAX_PENDING = 16;

/** A sign-in refused for a reason the caller should be told, with its HTTP status. */
export class CloudLoginError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CloudLoginError';
  }
}

export interface CloudLoginBegin {
  requestId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  nonce: string;
  /** Seconds before this request is forgotten and has to be begun again. */
  expiresIn: number;
}

export interface CloudUserSession {
  signedIn: boolean;
  user: { sub: string; name: string | null; email: string | null } | null;
  signedInVia: string | null;
  signedInAt: string | null;
  /** Why the last session ended without anyone signing out, if it did. */
  signedOutReason: string | null;
}

interface Pending {
  verifier: string;
  nonce: string;
  expiresAt: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** The S256 challenge for a verifier: base64url(SHA-256(V)), no padding. */
export function s256(verifier: string): string {
  return b64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

/**
 * The claims of an id_token, without verifying its signature.
 *
 * Signature verification is not needed here, and that is a deliberate reading of
 * OIDC Core §3.1.3.7 rather than a shortcut: this id_token arrives in the response
 * to RFDeck's own POST to Meros's token endpoint, over TLS, so TLS has already
 * authenticated who issued it. What still has to be checked is that it is *for
 * this client*, *for this sign-in* and *not expired* — which `checkIdToken` does.
 */
export function decodeIdToken(token: string | undefined): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Why an id_token cannot be accepted for this sign-in, or null when it can. */
export function checkIdToken(
  claims: Record<string, any> | null,
  expected: { clientId: string; nonce: string; issuer: string | null },
  now = Date.now(),
): string | null {
  if (!claims) return 'no readable id_token in the response';
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expected.clientId)) return 'the id_token is for a different client';
  if (typeof claims.sub !== 'string' || claims.sub.trim() === '') return 'the id_token has no sub';
  if (claims.nonce !== expected.nonce) return 'the id_token does not belong to this sign-in (nonce mismatch)';
  if (typeof claims.exp === 'number' && claims.exp * 1000 < now - 60_000) return 'the id_token has expired';
  if (expected.issuer && claims.iss && claims.iss !== expected.issuer) return 'the id_token was issued by a different issuer';
  return null;
}

export class CloudUserLogin {
  private readonly pending = new Map<string, Pending>();
  /** In memory only; it lives an hour and the refresh token can always mint another. */
  private accessToken: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private signedOutReason: string | null = null;

  constructor(
    private readonly config: CloudConfig,
    private readonly client: CloudClient,
    private readonly store: CloudUserStore,
    private readonly onChange: () => void = () => {},
  ) {}

  /** The client this install redeems as, or null until it is configured. */
  get clientId(): string | null {
    return this.config.cloudUserClientId ?? null;
  }

  private requireClient(): string {
    const id = this.clientId;
    if (!id) {
      throw new CloudLoginError(
        503, 'not_configured',
        'Signing in from Manifold is not configured on this server (MEROS_CLIENT_ID_CLOUD_USER is not set).',
      );
    }
    return id;
  }

  // ── Begin ─────────────────────────────────────────────────────────────────

  begin(): CloudLoginBegin {
    this.requireClient();
    this.prune();

    // 32 random bytes is a 43-character base64url verifier: inside the 43–128
    // characters of [A-Za-z0-9._~-] that RFC 7636 and Meros require.
    const verifier = b64url(crypto.randomBytes(32));
    const nonce = b64url(crypto.randomBytes(16));
    const requestId = b64url(crypto.randomBytes(16));
    this.pending.set(requestId, { verifier, nonce, expiresAt: Date.now() + PENDING_TTL_MS });

    return {
      requestId,
      codeChallenge: s256(verifier),
      codeChallengeMethod: 'S256',
      nonce,
      expiresIn: PENDING_TTL_MS / 1000,
    };
  }

  /** Drop expired requests, and the oldest beyond the ceiling. */
  private prune() {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string;
      this.pending.delete(oldest);
    }
  }

  // ── Complete ──────────────────────────────────────────────────────────────

  async complete(requestId: string, loginToken: string): Promise<CloudUserSession & { replacedPrevious: boolean }> {
    const clientId = this.requireClient();
    const pending = this.pending.get(requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pending.delete(requestId);
      throw new CloudLoginError(404, 'unknown_request',
        'This sign-in was not begun here, or it expired. Begin it again.');
    }

    let token: TokenResponse;
    try {
      token = await this.client.json<TokenResponse>('POST', await this.client.tokenEndpoint(), {
        form: {
          grant_type: 'urn:meros:params:oauth:grant-type:sso-ticket',
          login_token: loginToken,
          client_id: clientId,
          code_verifier: pending.verifier,
          scope: CLOUD_USER_SCOPES.join(' '),
        },
      });
    } catch (err) {
      if (err instanceof CloudOffline) {
        // Kept, deliberately: Meros allows the same client to redeem a login token
        // once more within 60 s, so Manifold can call `complete` again and recover.
        throw new CloudLoginError(502, 'meros_unreachable', 'Could not reach Meros to complete the sign-in. Try again.');
      }
      this.pending.delete(requestId);
      if (err instanceof CloudRefused && err.code === 'invalid_grant') {
        // One error for every ticket failure: unknown, expired, already used,
        // minted for another client, or a wrong verifier.
        throw new CloudLoginError(401, 'invalid_grant', 'Meros did not accept this login token. Begin the sign-in again.');
      }
      const code = err instanceof CloudRefused && err.code ? err.code : 'meros_refused';
      throw new CloudLoginError(502, code, (err as Error)?.message ?? 'Meros refused the sign-in.');
    }
    // `pending` is kept until the sign-in is stored. If storing fails, Manifold
    // can call `complete` again with the same login token: Meros lets the same
    // client redeem it once more within 60 s, and the verifier is still here.
    // (A process restart loses the verifier, so after a crash the sign-in has to
    // be begun again; that is the safe direction to fail in.)

    // Never sign anyone in on an identity this sign-in cannot vouch for.
    let issuer: string | null = null;
    try { issuer = (await this.client.discover()).issuer ?? null; } catch { /* checked without it */ }
    const claims = decodeIdToken(token.id_token);
    const problem = checkIdToken(claims, { clientId, nonce: pending.nonce, issuer });
    if (problem || !token.refresh_token) {
      this.pending.delete(requestId);
      await this.revoke(token.access_token);
      const why = problem ?? 'Meros returned no refresh token';
      log.warn(`[Cloud] Refused a Manifold sign-in: ${why}`);
      throw new CloudLoginError(502, 'invalid_response', `Meros's answer could not be accepted: ${why}.`);
    }

    const previous = await this.store.read();
    const replacedPrevious = !!previous && previous.sub !== claims!.sub;
    if (replacedPrevious && this.accessToken) await this.revoke(this.accessToken.value);

    // Stored before the access token is used: see the class comment.
    await this.store.signIn({
      sub: claims!.sub,
      name: typeof claims!.name === 'string' ? claims!.name : null,
      email: typeof claims!.email === 'string' ? claims!.email : null,
      signedInVia: 'manifold',
    }, token.refresh_token);
    this.pending.delete(requestId);
    this.keepAccess(token);
    this.signedOutReason = null;

    log.warn(`[Cloud] Cloud user ${claims!.email ?? claims!.sub} signed in from Manifold` +
      (replacedPrevious ? `, replacing ${previous!.email ?? previous!.sub}` : ''));
    this.onChange();
    return { ...(await this.session()), replacedPrevious };
  }

  private keepAccess(token: TokenResponse) {
    this.accessToken = {
      value: token.access_token,
      expiresAt: Date.now() + Math.max(30, (token.expires_in ?? 3600) - 60) * 1000,
    };
  }

  // ── Session ───────────────────────────────────────────────────────────────

  async session(): Promise<CloudUserSession> {
    const user = await this.store.read();
    return {
      signedIn: !!user,
      user: user ? { sub: user.sub, name: user.name, email: user.email } : null,
      signedInVia: user?.signedInVia ?? null,
      signedInAt: user?.signedInAt.toISOString() ?? null,
      signedOutReason: user ? null : this.signedOutReason,
    };
  }

  /**
   * An access token for the signed-in cloud user, refreshing when needed.
   *
   * Concurrent callers share one refresh: two simultaneous refreshes would present
   * the same refresh token, and the second would look like a replay.
   */
  async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) return this.accessToken.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const clientId = this.requireClient();
    const user = await this.store.read();
    if (!user?.refreshToken) throw new CloudLoginError(401, 'not_signed_in', 'No cloud user is signed in.');

    let token: TokenResponse;
    try {
      token = await this.client.json<TokenResponse>('POST', await this.client.tokenEndpoint(), {
        form: { grant_type: 'refresh_token', refresh_token: user.refreshToken, client_id: clientId },
      });
    } catch (err) {
      if (err instanceof CloudRefused && (err.code === 'invalid_grant' || err.status === 400 || err.status === 401)) {
        // Revoked, expired or replayed. Retrying cannot help.
        this.signedOutReason = 'Meros no longer accepts this sign-in. Sign in again from Manifold.';
        this.accessToken = null;
        await this.store.clear();
        log.warn(`[Cloud] Cloud user ${user.email ?? user.sub} signed out: ${this.signedOutReason}`);
        this.onChange();
        throw new CloudLoginError(401, 'invalid_grant', this.signedOutReason);
      }
      throw err;
    }
    if (token.refresh_token) await this.store.saveRefreshToken(user.sub, token.refresh_token);
    this.keepAccess(token);
    return token.access_token;
  }

  // ── Sign out ──────────────────────────────────────────────────────────────

  /**
   * Revoke at Meros, then forget locally.
   *
   * Revokes the access token, which revokes its refresh token with it; Meros
   * also accepts the refresh token directly. Either works **only if the request
   * names the client** — without `client_id`, Meros answers 200 and revokes
   * nothing, which looks exactly like success. Local state is cleared even when
   * Meros is unreachable: an operator who signed out must not stay signed in
   * because the venue's uplink was down.
   */
  async signOut(): Promise<{ signedIn: false; revoked: boolean }> {
    let revoked = false;
    if (await this.store.read()) {
      let access: string | null = null;
      try { access = await this.token(); } catch { /* offline or already refused */ }
      if (access) revoked = await this.revoke(access);
    }
    await this.store.clear();
    this.accessToken = null;
    this.signedOutReason = null;
    log.warn(`[Cloud] Cloud user signed out on this server${revoked ? ' and revoked at Meros' : ''}`);
    this.onChange();
    return { signedIn: false, revoked };
  }

  private async revoke(accessToken: string): Promise<boolean> {
    const clientId = this.clientId;
    if (!clientId) return false;
    try {
      const endpoint = await this.client.revocationEndpoint();
      if (!endpoint) return false;
      await this.client.json('POST', endpoint, {
        form: { token: accessToken, client_id: clientId, token_type_hint: 'access_token' },
      });
      return true;
    } catch (err) {
      this.client.logOnce('Revoking the cloud user at Meros failed', err);
      return false;
    }
  }
}
