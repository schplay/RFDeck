import { prisma } from '../db';
import { log } from '../logger';
import { CloudConfig, INSTANCE_SCOPES } from './config';
import { CloudLocalState, CloudOffline, CloudRefused, MerosClient, MerosSession } from './merosClient';

/**
 * The instance link: this RFDeck server, acting within a Meros account.
 *
 * The device grant (RFC 8628) because a rig may have no browser of its own and
 * may be reachable only over a show LAN. The operator opens meros.co/link on any
 * device — a phone is fine — and approves this instance into one of their
 * accounts.
 *
 * The grant, the rotating refresh token and its storage are the meros-client
 * helper's: it commits a rotated token before using the access token it came
 * with, serializes every call on a lock (a refresh token used twice revokes the
 * whole family), and forgets the session when Meros refuses a refresh. What is
 * left here is the polling loop the UI watches and telling the operator when the
 * link has died and has to be made again.
 */

/** A device-flow attempt in progress, as the UI shows it. */
export interface PendingLink {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  intervalMs: number;
  /** Set when polling has finished, one way or the other. */
  outcome: 'pending' | 'linked' | 'denied' | 'expired' | 'error';
  detail: string | null;
}

/** Codes that mean the stored link is gone and only re-linking will help. */
const DEAD_LINK_CODES = new Set(['invalid_grant', 'token_rejected', 'no_sign_in']);

export class CloudLink {
  private pending: PendingLink | null = null;
  private poller: NodeJS.Timeout | null = null;
  /** Set when the link is dead and only the operator can fix it. */
  private relinkReason: string | null = null;
  readonly session: MerosSession;

  constructor(
    config: CloudConfig,
    private readonly meros: MerosClient,
    private readonly onChange: () => void = () => {},
  ) {
    this.session = { name: 'instance', clientId: config.clientId, scopes: INSTANCE_SCOPES };
  }

  get needsRelink(): string | null {
    return this.relinkReason;
  }

  get pendingLink(): PendingLink | null {
    return this.pending;
  }

  /** Run a cloud command as this instance, noticing when the link has died. */
  async run<T = any>(command: string, input: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.meros.run<T>(command, input, this.session);
    } catch (err) {
      await this.observe(err);
      throw err;
    }
  }

  /**
   * Note a refusal that means the link is gone.
   *
   * `invalid_grant` on a refresh is the helper forgetting the session; the next
   * call then answers `no_sign_in`. Either way a retry cannot help, and a
   * background loop would hide the one thing the operator needs told.
   */
  private async observe(err: unknown): Promise<void> {
    const code = err instanceof CloudRefused || err instanceof CloudLocalState ? err.code : null;
    if (!code || !DEAD_LINK_CODES.has(code)) return;
    if (code === 'no_sign_in' && !(await this.wasLinked())) return;
    if (this.relinkReason) return;
    this.relinkReason =
      'Meros rejected this instance’s stored credentials. The link has to be ' +
      'established again from Settings → Cloud.';
    await this.forgetLocally();
    log.warn(`[Cloud] Link is dead — ${code}`);
    this.onChange();
  }

  // ── Linking ───────────────────────────────────────────────────────────────

  /** Start the device flow and begin polling. */
  async start(): Promise<PendingLink> {
    this.cancel();
    const res = await this.meros.run<{
      user_code: string; verification_uri: string; verification_uri_complete?: string | null;
      interval?: number; expires_at?: number;
    }>('signin.start', {}, this.session);

    this.pending = {
      userCode: res.user_code,
      verificationUri: res.verification_uri,
      verificationUriComplete: res.verification_uri_complete ?? null,
      expiresAt: res.expires_at ? res.expires_at * 1000 : Date.now() + 600_000,
      intervalMs: Math.max(1, res.interval ?? 5) * 1000,
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
    if (this.pending?.outcome === 'pending') {
      void this.meros.run('signin.cancel', {}, this.session).catch(() => {});
    }
    this.pending = null;
  }

  private schedulePoll() {
    if (!this.pending) return;
    this.poller = setTimeout(() => void this.poll(), this.pending.intervalMs);
  }

  private finish(outcome: PendingLink['outcome'], detail: string | null) {
    if (!this.pending) return;
    this.pending.outcome = outcome;
    this.pending.detail = detail;
    this.onChange();
  }

  private async poll() {
    const pending = this.pending;
    if (!pending || pending.outcome !== 'pending') return;

    try {
      const res = await this.meros.run<{ status: string; interval?: number }>('signin.poll', {}, this.session);
      if (res.status === 'signed_in') {
        this.relinkReason = null;
        await this.recordLinked();
        log.warn('[Cloud] Instance linked to Meros');
        this.finish('linked', null);
        return;
      }
      // Pending. The helper raises the interval when Meros says to slow down.
      if (res.interval) pending.intervalMs = Math.max(1, res.interval) * 1000;
    } catch (err) {
      if (err instanceof CloudRefused) {
        if (err.code === 'access_denied') return this.finish('denied', 'The request was declined at meros.co.');
        if (err.code === 'expired_token') {
          return this.finish('expired', 'The code expired before it was approved. Start again.');
        }
        log.warn(`[Cloud] Link failed: ${err.message}`);
        return this.finish('error', err.message);
      }
      if (!(err instanceof CloudOffline)) {
        return this.finish('error', (err as Error)?.message ?? 'unknown');
      }
      // Offline: the operator may simply be approving it on a phone while the
      // venue's uplink flaps. Keep polling until the code expires.
      if (Date.now() > pending.expiresAt) {
        return this.finish('expired', 'The code expired before it was approved. Start again.');
      }
    }
    this.schedulePoll();
  }

  /**
   * An access token for this instance, for the one caller that still calls
   * Meros itself (the signed data feeds). The helper refreshes it when needed.
   */
  async token(): Promise<string> {
    const res = await this.run<{ access_token: string }>('signin.token');
    return res.access_token;
  }

  async isLinked(): Promise<boolean> {
    try {
      const res = await this.meros.run<{ signed_in: boolean }>('signin.status', {}, this.session);
      return res.signed_in === true;
    } catch {
      return false;
    }
  }

  // ── What RFDeck records about the link ────────────────────────────────────
  //
  // When it was made, for "linked since". The credentials are the helper's.

  private async wasLinked(): Promise<boolean> {
    return !!(await prisma.settings.findFirst())?.cloudLinkedAt;
  }

  private async recordLinked(): Promise<void> {
    const settings = await prisma.settings.findFirst() ?? await prisma.settings.create({ data: {} });
    await prisma.settings.update({ where: { id: settings.id }, data: { cloudLinkedAt: new Date() } });
  }

  private async forgetLocally(): Promise<void> {
    const settings = await prisma.settings.findFirst();
    if (!settings) return;
    await prisma.settings.update({ where: { id: settings.id }, data: { cloudLinkedAt: null } });
  }

  // ── Unlinking ─────────────────────────────────────────────────────────────

  /**
   * Revoke at Meros and forget locally.
   *
   * The helper forgets the session even when the revoke cannot reach Meros: an
   * operator who has said "unlink" must not be left linked because the venue's
   * uplink was down.
   */
  async unlink(): Promise<void> {
    this.cancel();
    try {
      await this.meros.run('signin.signout', {}, this.session);
    } catch (err) {
      log.warn(`[Cloud] Unlinking: ${(err as Error).message}`);
    }
    await this.forgetLocally();
    this.relinkReason = null;
    log.warn('[Cloud] Instance unlinked');
    this.onChange();
  }
}
