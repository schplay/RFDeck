import { prisma } from '../db';
import { log } from '../logger';
import { CloudConfig, INSTANCE_SCOPES } from './config';
import { CloudLocalState, CloudRefused, MerosClient, MerosSession } from './merosClient';

/**
 * The instance link: this RFDeck server, acting within a Meros account.
 *
 * Made by signing in with Meros in a browser (see `signIn.ts`): RFDeck Desktop
 * through the helper's loopback sign-in, a server through a redirect from the
 * browser that reached it, with the RFDeck Server client.
 *
 * The rotating refresh token and its storage are the meros-client helper's: it
 * commits a rotated token before using the access token it came with,
 * serializes every call on a lock (a refresh token used twice revokes the whole
 * family), and forgets the session when Meros refuses a refresh. What is left
 * here is recording the link and telling the operator when it has died and has
 * to be made again.
 */

/** Codes that mean the stored link is gone and only re-linking will help. */
const DEAD_LINK_CODES = new Set(['invalid_grant', 'token_rejected', 'no_sign_in']);

export class CloudLink {
  /** Set when the link is dead and only the operator can fix it. */
  private relinkReason: string | null = null;
  readonly session: MerosSession;

  constructor(
    readonly config: CloudConfig,
    private readonly meros: MerosClient,
    private readonly onChange: () => void = () => {},
  ) {
    this.session = { name: 'instance', clientId: config.clientId, scopes: INSTANCE_SCOPES };
  }

  get needsRelink(): string | null {
    return this.relinkReason;
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

  /** The sign-in that makes the link has finished. */
  async linked(): Promise<void> {
    this.relinkReason = null;
    await this.recordLinked();
    log.warn('[Cloud] Instance linked to Meros');
    this.onChange();
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
