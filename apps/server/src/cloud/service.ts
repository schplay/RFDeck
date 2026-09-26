import { Server } from 'socket.io';
import { prisma } from '../db';
import { log } from '../logger';
import { CloudClient } from './client';
import { CloudConfig, readCloudConfig } from './config';
import { CloudLink, PendingLink } from './link';
import { PrismaLinkStore, PrismaEntitlementCache } from './linkStore';
import { Entitlements } from './entitlements';
import { Documents } from './documents';
import { ShowFiles } from './showFiles';
import { CloudStatus } from './types';

/**
 * Everything RFDeck does with Meros Cloud, in one object.
 *
 * Deliberately shaped so that "no cloud" is the resting state rather than a
 * degraded one: if nothing is configured, this exists, answers
 * `configured: false`, and does nothing else. The application has never needed
 * the cloud and still does not.
 */
export class CloudService {
  readonly configured: boolean;
  private readonly client: CloudClient | null;
  private readonly link: CloudLink | null;
  private readonly entitlements: Entitlements | null;
  /** Show files. Null when the cloud is not configured. */
  readonly showFiles: ShowFiles | null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly io: Server, config: CloudConfig | null = readCloudConfig()) {
    this.configured = !!config;
    if (!config) {
      this.client = null;
      this.link = null;
      this.entitlements = null;
      this.showFiles = null;
      log.debug('[Cloud] Not configured (no MEROS_BASE_URL / MEROS_CLIENT_ID) — cloud features are off');
      return;
    }
    this.client = new CloudClient(config);
    const announce = () => void this.announce();
    this.link = new CloudLink(config, this.client, new PrismaLinkStore(), announce);
    this.entitlements = new Entitlements(this.client, this.link, new PrismaEntitlementCache(), announce);
    this.showFiles = new ShowFiles(new Documents(this.client, this.link));
    this.config = config;
    log.info(`[Cloud] Configured for ${config.baseUrl} as client ${config.clientId}`);
  }

  private config: CloudConfig | null = null;

  /**
   * Read entitlements now and then hourly.
   *
   * Hourly rather than on demand because the answer is cached and honoured
   * offline: the point of polling is to keep the cache fresh while there *is* a
   * network, so that there is something honest to fall back on when there is not.
   */
  async start() {
    if (!this.link || !this.entitlements) return;
    if (!(await this.link.isLinked())) {
      log.debug('[Cloud] Configured but not linked');
      return;
    }
    await this.entitlements.refresh();
    this.refreshTimer = setInterval(() => void this.entitlements!.refresh(), 60 * 60_000);
  }

  stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.link?.cancel();
  }

  // ── Linking, for the routes ───────────────────────────────────────────────

  async startLink(): Promise<PendingLink> {
    if (!this.link) throw new Error('Meros Cloud is not configured on this server.');
    return this.link.start();
  }

  linkProgress(): PendingLink | null {
    return this.link?.pendingLink ?? null;
  }

  cancelLink() {
    this.link?.cancel();
  }

  async unlink() {
    if (!this.link) return { revoked: false };
    const result = await this.link.unlink();
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    return result;
  }

  /** Called after a successful link to pick up the account and its entitlements. */
  async afterLink() {
    if (!this.entitlements) return;
    await this.entitlements.refresh();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => void this.entitlements!.refresh(), 60 * 60_000);
    }
  }

  // ── The single gate ───────────────────────────────────────────────────────

  /**
   * Is this feature available? The one question, asked in one place.
   *
   * Always true while gating is deferred — see `entitlements.ts`. Unconfigured
   * or unlinked installs answer the same way, because a paywall that appears
   * because somebody has not signed in is not a paywall anyone asked for.
   */
  async entitled(feature: string): Promise<boolean> {
    if (!this.entitlements) return true;
    return this.entitlements.entitled(feature);
  }

  /** What the account actually holds, regardless of whether gating is on. */
  async holds(feature: string): Promise<boolean> {
    return this.entitlements ? this.entitlements.holds(feature) : false;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async status(): Promise<CloudStatus> {
    if (!this.config || !this.link || !this.entitlements) {
      return {
        configured: false, linked: false, accountId: null, linkedAt: null,
        lastRefreshAt: null, features: [], expiresAt: null, offline: false,
        needsRelink: null, browserClientId: null, baseUrl: null,
      };
    }
    const settings = await prisma.settings.findFirst();
    const snap = await this.entitlements.snapshot();
    return {
      configured: true,
      linked: !!settings?.cloudRefreshToken,
      accountId: settings?.cloudAccountId ?? snap.accountId,
      linkedAt: settings?.cloudLinkedAt?.toISOString() ?? null,
      lastRefreshAt: settings?.cloudLastRefreshAt?.toISOString() ?? null,
      features: snap.features,
      expiresAt: snap.expiresAt,
      // "Offline" means: we are working from a cached answer because the last
      // attempt to read a fresh one did not get through.
      offline: !!snap.lastError && !!settings?.cloudRefreshToken,
      needsRelink: this.link.needsRelink,
      browserClientId: this.config.browserClientId,
      baseUrl: this.config.baseUrl,
    };
  }

  /** Tell every open client, so a link or an expiry lands everywhere at once. */
  private async announce() {
    try {
      this.io.emit('cloud:status', await this.status());
    } catch (err) {
      log.debug(`[Cloud] Could not announce status: ${(err as Error).message}`);
    }
  }
}
