import { log } from '../logger';
import { CloudConfig, CLOUD_USER_SCOPES } from './config';
import { CloudUserStore } from './cloudUserStore';
import { CloudLocalState, CloudOffline, CloudRefused, MerosClient, MerosSession } from './merosClient';

/**
 * Signing a Meros cloud user in on this install, from a console.
 *
 * The operator signs in to Meros once, on the console. The console then asks Meros
 * for a single-use **login token** for RFDeck and hands it to this server, which
 * redeems it at Meros as RFDeck's own client — "RFDeck Cloud User" — and gets
 * RFDeck's own tokens, exactly as if the user had signed in here directly.
 *
 * The begin/complete pair keeps the PKCE verifier on this side: `begin` gives
 * the console only the challenge and a nonce, the console mints the login token with
 * them, and `complete` redeems it with the verifier the console never saw. The
 * verifier, the redeem, the id_token checks (client, nonce, subject, expiry,
 * issuer, a refresh token present), the rotating refresh token and revoking on
 * sign-out are the meros-client helper's (`signin.redeem.*`), in its own session
 * under the Cloud User client, so it can never revoke the instance link's
 * tokens or be revoked by them.
 *
 * A cloud logout on the console does not sign RFDeck out: RFDeck holds its own
 * tokens, and only signing out here, or Meros refusing the refresh, ends it.
 */

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

interface HelperUser { id: string; name?: string | null; email?: string | null }

export class CloudUserLogin {
  private signedOutReason: string | null = null;

  constructor(
    private readonly config: CloudConfig,
    private readonly meros: MerosClient,
    private readonly store: CloudUserStore,
    private readonly onChange: () => void = () => {},
  ) {}

  /** The client this install redeems as, or null until it is configured. */
  get clientId(): string | null {
    return this.config.cloudUserClientId ?? null;
  }

  private session_(): MerosSession {
    const id = this.clientId;
    if (!id) {
      throw new CloudLoginError(
        503, 'not_configured',
        'Signing in from a console is not configured on this server (MEROS_CLIENT_ID_CLOUD_USER is not set).',
      );
    }
    return { name: 'cloud-user', clientId: id, scopes: CLOUD_USER_SCOPES };
  }

  /** Start a sign-in: the challenge and nonce the console mints the login token with. */
  async begin(): Promise<CloudLoginBegin> {
    const session = this.session_();
    const res = await this.meros.run<{
      request_id: string; code_challenge: string; nonce: string; expires_at: number;
    }>('signin.redeem.begin', {}, session);
    return {
      requestId: res.request_id,
      codeChallenge: res.code_challenge,
      codeChallengeMethod: 'S256',
      nonce: res.nonce,
      expiresIn: Math.max(0, Math.round(res.expires_at - Date.now() / 1000)),
    };
  }

  /** Redeem the login token the console came back with. */
  async complete(requestId: string, loginToken: string): Promise<CloudUserSession & { replacedPrevious: boolean }> {
    const session = this.session_();
    const previous = await this.store.read();

    let res: { user: HelperUser; replaced_previous: boolean };
    try {
      res = await this.meros.run('signin.redeem.complete', { request_id: requestId, login_token: loginToken }, session);
    } catch (err) {
      if (err instanceof CloudOffline) {
        throw new CloudLoginError(502, 'meros_unreachable', 'Could not reach Meros to complete the sign-in. Try again.');
      }
      if (err instanceof CloudLocalState && err.code === 'unknown_request') {
        throw new CloudLoginError(404, 'unknown_request', 'This sign-in was not begun here, or it expired. Begin it again.');
      }
      if (err instanceof CloudRefused && err.code === 'invalid_grant') {
        throw new CloudLoginError(401, 'invalid_grant', 'Meros did not accept this login token. Begin the sign-in again.');
      }
      if (err instanceof CloudRefused && err.code === 'invalid_response') {
        log.warn(`[Cloud] Refused a console sign-in: ${err.message}`);
        throw new CloudLoginError(502, 'invalid_response', `Meros's answer could not be accepted: ${err.message}`);
      }
      const code = err instanceof CloudRefused && err.code ? err.code : 'meros_refused';
      throw new CloudLoginError(502, code, (err as Error)?.message ?? 'Meros refused the sign-in.');
    }

    await this.store.signIn({
      sub: res.user.id,
      name: res.user.name ?? null,
      email: res.user.email ?? null,
      signedInVia: 'manifold',
    });
    this.signedOutReason = null;
    log.warn(`[Cloud] Cloud user ${res.user.email ?? res.user.id} signed in from a console` +
      (res.replaced_previous && previous ? `, replacing ${previous.email ?? previous.sub}` : ''));
    this.onChange();
    return { ...(await this.session()), replacedPrevious: res.replaced_previous };
  }

  /**
   * Who is signed in, as the helper knows it.
   *
   * When the helper no longer has the session but this install still records
   * someone, Meros refused the refresh (a revoked token, a replayed one, an
   * expiry): the record goes, and the reason is kept to show once.
   */
  async session(): Promise<CloudUserSession> {
    const recorded = await this.store.read();
    let user: HelperUser | null = null;
    if (this.clientId) {
      try {
        const res = await this.meros.run<{ signed_in: boolean; user?: HelperUser }>('signin.status', {}, this.session_());
        user = res.signed_in && res.user ? res.user : null;
      } catch (err) {
        log.debug(`[Cloud] Reading the cloud user session failed: ${(err as Error).message}`);
        user = recorded ? { id: recorded.sub, name: recorded.name, email: recorded.email } : null;
      }
    }
    if (!user && recorded) {
      await this.store.clear();
      this.signedOutReason = 'Meros ended the session. Sign in again from the console.';
    }
    const same = user && recorded?.sub === user.id ? recorded : null;
    return {
      signedIn: !!user,
      user: user ? { sub: user.id, name: user.name ?? null, email: user.email ?? null } : null,
      signedInVia: same?.signedInVia ?? null,
      signedInAt: same?.signedInAt.toISOString() ?? null,
      signedOutReason: user ? null : this.signedOutReason,
    };
  }

  /**
   * Sign out: the helper revokes with the Cloud User client id (without which
   * Meros revokes nothing) and forgets the session even when Meros is
   * unreachable, so an operator who signed out never stays signed in because
   * the venue's uplink was down.
   */
  async signOut(): Promise<{ signedIn: false }> {
    try {
      await this.meros.run('signin.signout', {}, this.session_());
    } catch (err) {
      log.warn(`[Cloud] Signing the cloud user out: ${(err as Error).message}`);
    }
    await this.store.clear();
    this.signedOutReason = null;
    log.warn('[Cloud] Cloud user signed out on this server');
    this.onChange();
    return { signedIn: false };
  }
}
