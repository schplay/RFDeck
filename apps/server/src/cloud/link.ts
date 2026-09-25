import { log } from '../logger';
import { CloudClient, CloudOffline, CloudRefused } from './client';
import { LinkStore } from './linkStore';
import { CloudConfig, INSTANCE_SCOPES } from './config';
import { DeviceCodeResponse, TokenResponse } from './types';

/**
 * The instance link: this RFDeck server, acting within a Meros account.
 *
 * The device grant (RFC 8628) because a rig may have no browser of its own and
 * may be reachable only over a show LAN. The operator opens meros.co/link on any
 * device — a phone is fine — and approves this instance into one of their
 * accounts.
 *
 * ── The part that will bite if it is got wrong ───────────────────────────────
 *
 * Meros rotates the refresh token on every use, and replaying an already-rotated
 * one revokes the **entire (user, client) token family** as a breach response.
 * Three consequences, all enforced here rather than left to a caller:
 *
 *   1. The link is single-writer. One process owns it — the one that owns the
 *      database. A desktop build and a headless install are separate OAuth
 *      clients precisely so they cannot rotate the same token and revoke each
 *      other.
 *   2. The rotated token is committed *before* the access token it arrived with
 *      is used. Crash in between and the next start would present a stale token,
 *      which does not merely fail: it kills the link.
 *   3. `invalid_grant` on refresh means "unlinked, re-link" — not "retry". A
 *      background retry loop would hide the one thing the operator needs told.
 */

/** A device-flow attempt in progress. In memory: it is worthless after a restart. */
export interface PendingLink {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  intervalMs: number;
  /** Set when polling has finished, one way or the other. */
  outcome: 'pending' | 'linked' | 'denied' | 'expired' | 'error';
  detail: string | null;
}

export class CloudLink {
  private pending: PendingLink | null = null;
  private poller: NodeJS.Timeout | null = null;
  /** In-memory access token; never persisted — it lives an hour. */
  private accessToken: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  /** Set when the link is dead and only the operator can fix it. */
  private relinkReason: string | null = null;

  constructor(
    private readonly config: CloudConfig,
    private readonly client: CloudClient,
    private readonly store: LinkStore,
    private readonly onChange: () => void = () => {},
  ) {}

  get needsRelink(): string | null {
    return this.relinkReason;
  }

  get pendingLink(): PendingLink | null {
    return this.pending;
  }

  // ── Linking ───────────────────────────────────────────────────────────────

  /** Start the device flow and begin polling. */
  async start(): Promise<PendingLink> {
    this.cancel();
    const endpoint = await this.client.deviceEndpoint();
    const res = await this.client.json<DeviceCodeResponse>('POST', endpoint, {
      form: { client_id: this.config.clientId, scope: INSTANCE_SCOPES.join(' ') },
    });

    // RFC 8628 §3.2: absent interval means 5 seconds. Honouring the server's
    // number matters because `slow_down` is a real answer and polling too fast
    // is how you earn it.
    const intervalMs = Math.max(1, res.interval ?? 5) * 1000;
    this.pending = {
      deviceCode: res.device_code,
      userCode: res.user_code,
      verificationUri: res.verification_uri,
      verificationUriComplete: res.verification_uri_complete ?? null,
      expiresAt: Date.now() + Math.max(60, res.expires_in ?? 600) * 1000,
      intervalMs,
      outcome: 'pending',
      detail: null,
    };
    log.info(`[Cloud] Link started — approve at ${res.verification_uri} with code ${res.user_code}`);
    this.schedulePoll();
    this.onChange();
    return this.pending;
  }

  cancel() {
    if (this.poller) { clearTimeout(this.poller); this.poller = null; }
    this.pending = null;
  }

  private schedulePoll() {
    if (!this.pending) return;
    this.poller = setTimeout(() => void this.poll(), this.pending.intervalMs);
  }

  private async poll() {
    const pending = this.pending;
    if (!pending || pending.outcome !== 'pending') return;

    if (Date.now() > pending.expiresAt) {
      pending.outcome = 'expired';
      pending.detail = 'The code expired before it was approved. Start again.';
      log.warn('[Cloud] Link code expired before approval');
      this.onChange();
      return;
    }

    try {
      const endpoint = await this.client.tokenEndpoint();
      const token = await this.client.json<TokenResponse>('POST', endpoint, {
        form: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: pending.deviceCode,
          client_id: this.config.clientId,
        },
      });
      await this.keep(token);
      pending.outcome = 'linked';
      log.warn('[Cloud] Instance linked to Meros');
      this.onChange();
      return;
    } catch (err) {
      if (err instanceof CloudRefused) {
        switch (err.code) {
          case 'authorization_pending':
            break;                                  // normal: keep waiting
          case 'slow_down':
            pending.intervalMs += 5_000;             // RFC 8628 §3.5
            break;
          case 'access_denied':
            pending.outcome = 'denied';
            pending.detail = 'The request was declined at meros.co.';
            this.onChange();
            return;
          case 'expired_token':
            pending.outcome = 'expired';
            pending.detail = 'The code expired before it was approved. Start again.';
            this.onChange();
            return;
          default:
            pending.outcome = 'error';
            pending.detail = err.message;
            log.warn(`[Cloud] Link failed: ${err.message}`);
            this.onChange();
            return;
        }
      } else if (!(err instanceof CloudOffline)) {
        pending.outcome = 'error';
        pending.detail = (err as Error)?.message ?? 'unknown';
        this.onChange();
        return;
      }
      // Offline: the operator may simply be approving it on a phone while the
      // venue's uplink flaps. Keep polling until the code expires.
    }
    this.schedulePoll();
  }

  /**
   * Persist a token response.
   *
   * The refresh token is committed to the database *before* the access token is
   * put in memory for use — see the class comment. Deliberately not clever: the
   * write happens first, always, even when it costs a round trip.
   */
  private async keep(token: TokenResponse) {
    if (token.refresh_token) {
      await this.store.saveRefreshToken(token.refresh_token);
    }
    this.accessToken = {
      value: token.access_token,
      // 60s of headroom: a token that expires mid-request is a retry we can
      // simply not have.
      expiresAt: Date.now() + Math.max(30, (token.expires_in ?? 3600) - 60) * 1000,
    };
    this.relinkReason = null;
  }

  async isLinked(): Promise<boolean> {
    return !!(await this.store.readRefreshToken());
  }

  // ── Using the link ────────────────────────────────────────────────────────

  /**
   * A usable access token, refreshing if necessary.
   *
   * Concurrent callers share one refresh. Two simultaneous refreshes would each
   * present the same refresh token, and the second would look like a replay —
   * which is exactly the thing that revokes the family.
   */
  async token(): Promise<string> {
    if (this.relinkReason) throw new CloudRefused(401, 'invalid_grant', this.relinkReason);
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) return this.accessToken.value;
    if (this.refreshing) return this.refreshing;

    this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const stored = await this.store.readRefreshToken();
    if (!stored) throw new CloudRefused(401, 'not_linked', 'This instance is not linked to Meros.');

    const endpoint = await this.client.tokenEndpoint();
    let token: TokenResponse;
    try {
      token = await this.client.json<TokenResponse>('POST', endpoint, {
        form: {
          grant_type: 'refresh_token',
          refresh_token: stored,
          client_id: this.config.clientId,
        },
      });
    } catch (err) {
      if (err instanceof CloudRefused && (err.code === 'invalid_grant' || err.status === 400 || err.status === 401)) {
        // The refresh token is gone: rotated and replayed, revoked at Meros, or
        // the family was killed. Retrying cannot help, and a loop would hide it.
        await this.markUnlinked(
          'Meros rejected this instance’s stored credentials. The link has to be ' +
          'established again from Settings → Cloud.',
        );
        throw new CloudRefused(401, 'invalid_grant', this.relinkReason!);
      }
      throw err;
    }
    await this.keep(token);
    log.debug('[Cloud] Access token refreshed');
    this.onChange();
    return this.accessToken!.value;
  }

  private async markUnlinked(reason: string) {
    this.relinkReason = reason;
    this.accessToken = null;
    await this.store.saveRefreshToken(null);
    log.warn(`[Cloud] Link is dead — ${reason}`);
    this.onChange();
  }

  // ── Unlinking ─────────────────────────────────────────────────────────────

  /**
   * Revoke at Meros, then forget locally.
   *
   * Local state is cleared even when the revoke fails: an operator who has said
   * "unlink" must not be left linked because the venue's uplink was down. The
   * token stops working when Meros next sees it either way.
   */
  async unlink(): Promise<{ revoked: boolean }> {
    const stored = await this.store.readRefreshToken();
    let revoked = false;

    if (stored) {
      try {
        const endpoint = await this.client.revocationEndpoint();
        if (endpoint) {
          await this.client.json('POST', endpoint, {
            form: { token: stored, client_id: this.config.clientId, token_type_hint: 'refresh_token' },
          });
          revoked = true;
        }
      } catch (err) {
        this.client.logOnce('Revoking the link at Meros failed; clearing it locally anyway', err);
      }
    }

    await this.store.forgetLink();
    this.accessToken = null;
    this.relinkReason = null;
    this.cancel();
    log.warn(`[Cloud] Instance unlinked${revoked ? ' and revoked at Meros' : ''}`);
    this.onChange();
    return { revoked };
  }
}
