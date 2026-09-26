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
import { Feeds } from './feeds';
import { RegionalData, parseVenueLocation, OccupancyResult } from './regionalData';
import { Events, EmitInput } from './events';
import { DeviceProfiles } from './deviceProfiles';
import { COORDINATION_FAMILIES } from '../hardware/coordination/profiles';
import crypto from 'crypto';
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
  /** Regional TV occupancy. Null when the cloud is not configured. */
  readonly regional: RegionalData | null;
  /** The event stream. Always present, so callers never branch on the cloud. */
  readonly events: Events | null = null;
  /** Device-profile overrides from the public pack. */
  readonly deviceProfiles: DeviceProfiles | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private regionalTimer: NodeJS.Timeout | null = null;

  constructor(private readonly io: Server, config: CloudConfig | null = readCloudConfig()) {
    this.configured = !!config;
    if (!config) {
      this.client = null;
      this.link = null;
      this.entitlements = null;
      this.showFiles = null;
      this.regional = null;
      log.debug('[Cloud] Not configured (no MEROS_BASE_URL / MEROS_CLIENT_ID) — cloud features are off');
      return;
    }
    this.client = new CloudClient(config);
    const announce = () => void this.announce();
    this.link = new CloudLink(config, this.client, new PrismaLinkStore(), announce);
    this.entitlements = new Entitlements(this.client, this.link, new PrismaEntitlementCache(), announce);
    this.showFiles = new ShowFiles(new Documents(this.client, this.link));
    const feeds = new Feeds(config, this.client, this.link);
    this.regional = new RegionalData(feeds);
    this.deviceProfiles = new DeviceProfiles(feeds, COORDINATION_FAMILIES);
    this.events = new Events(
      this.client, this.link,
      // Replaced with the persisted id in start(); a placeholder until then so
      // nothing can emit under an id that is not the install's.
      'pending', process.env.RFDECK_VERSION ?? '0.0.0',
      process.env.RFDECK_EDITION === 'desktop' ? 'desktop' : 'server',
    );
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
    await this.configureEvents();
    await this.entitlements.refresh();
    this.refreshTimer = setInterval(() => void this.entitlements!.refresh(), 60 * 60_000);
    void this.refreshRegional();
    // Public pack, so this does not wait on the link or an entitlement.
    void this.deviceProfiles?.refresh();
    // Meros republishes weekly, so daily is generous and costs one conditional
    // request per cell when nothing has changed.
    this.regionalTimer = setInterval(() => void this.refreshRegional(), 24 * 60 * 60_000);
  }

  stop() {
    this.events?.stop();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.regionalTimer) clearInterval(this.regionalTimer);
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

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Give the emitter its identity and its collectors.
   *
   * The instance id is generated once and kept: collectors dedupe on
   * `(source.instance, id)`, so changing it would orphan everything already sent
   * and make one install look like two.
   */
  private async configureEvents(): Promise<void> {
    if (!this.events || !this.config) return;
    const settings = await prisma.settings.findFirst() ?? await prisma.settings.create({ data: {} });

    let instanceId = settings.eventInstanceId;
    if (!instanceId) {
      instanceId = crypto.randomUUID();
      await prisma.settings.update({
        where: { id: settings.id }, data: { eventInstanceId: instanceId },
      });
      log.info(`[Cloud] This install's event instance id is ${instanceId}`);
    }
    (this.events as any).instanceId = instanceId;
    // Continue the series rather than restarting it: a collector reads a repeated
    // or reversed sequence number as a gap.
    (this.events as any).seq = settings.eventSeq ?? 0;

    this.events.setCollectors(
      settings.eventToCloud && settings.cloudRefreshToken
        // `token: undefined` means "use the instance link's access token".
        ? [{ name: 'Meros Cloud', url: this.config.baseUrl }]
        : [],
    );
    if (this.eventSeqTimer) clearInterval(this.eventSeqTimer);
    // Persisted periodically rather than on every event: a lost handful of
    // numbers after a hard kill is harmless, and a write per event would not be.
    this.eventSeqTimer = setInterval(() => void this.persistSeq(), 60_000);
  }

  private eventSeqTimer: NodeJS.Timeout | null = null;

  private async persistSeq(): Promise<void> {
    try {
      const seq = (this.events as any)?.seq ?? 0;
      const settings = await prisma.settings.findFirst();
      if (settings && seq > (settings.eventSeq ?? 0)) {
        await prisma.settings.update({ where: { id: settings.id }, data: { eventSeq: seq } });
      }
    } catch { /* bookkeeping; never worth surfacing */ }
  }

  /** Turn the cloud collector on or off. */
  async setEventsToCloud(enabled: boolean): Promise<void> {
    const settings = await prisma.settings.findFirst() ?? await prisma.settings.create({ data: {} });
    await prisma.settings.update({ where: { id: settings.id }, data: { eventToCloud: enabled } });
    await this.configureEvents();
    await this.announcePublic();
  }

  /**
   * Record that something happened.
   *
   * Safe to call from anywhere, including when the cloud is not configured — it
   * costs an object and a push, and with no collectors it does not even do that.
   */
  emit(input: EmitInput): void {
    this.events?.emit(input);
  }

  // ── Regional data ─────────────────────────────────────────────────────────

  /** The venue location as coordinates, or null when unset or unparseable. */
  private async venue() {
    const settings = await prisma.settings.findFirst();
    return parseVenueLocation(settings?.venueLocation ?? null);
  }

  /** Bring the venue's cells up to date. Soft-fails: an offline rig keeps its cache. */
  async refreshRegional(): Promise<void> {
    if (!this.regional) return;
    // Gated, so an account without the subscription does not poll a feed it
    // cannot read. With gating deferred this is granted, which is the point of
    // there being one gate.
    if (!(await this.entitled('rfdeck.regional-data'))) return;
    try {
      await this.regional.refresh(await this.venue());
    } catch (err) {
      log.debug(`[Cloud] Regional refresh failed: ${(err as Error).message}`);
    }
  }

  /**
   * TV occupancy at the venue, from cache alone.
   *
   * Never touches the network: this is asked while an operator is standing at a
   * rack about to tune a rig, and a show-time action must not wait on a venue's
   * uplink.
   */
  async occupancy(): Promise<OccupancyResult> {
    if (!this.regional) {
      return {
        exclusions: null, unmapped: [], source: 'none', oldestFetchedAt: null,
        cellsUsed: [], reason: 'Meros Cloud is not configured on this server.',
      };
    }
    if (!(await this.entitled('rfdeck.regional-data'))) {
      return {
        exclusions: null, unmapped: [], source: 'none', oldestFetchedAt: null,
        cellsUsed: [],
        reason: 'Regional data is part of the paid cloud tier.',
      };
    }
    return this.regional.occupancyAt(await this.venue());
  }

  /** The TV exclusions for the coordinator, in kHz pairs. Empty when unavailable. */
  async tvExclusionRanges(): Promise<Array<[number, number]>> {
    const result = await this.occupancy();
    if (!result.exclusions) return [];
    return result.exclusions.map(e => e.rangeKHz);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async status(): Promise<CloudStatus> {
    if (!this.config || !this.link || !this.entitlements) {
      return {
        configured: false, linked: false, accountId: null, linkedAt: null,
        lastRefreshAt: null, features: [], expiresAt: null, offline: false,
        needsRelink: null, browserClientId: null, baseUrl: null,
        eventsToCloud: false, eventsQueued: 0,
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
      eventsToCloud: settings?.eventToCloud ?? false,
      eventsQueued: this.events?.queued ?? 0,
    };
  }

  /** Public wrapper, for callers outside this class. */
  async announcePublic() {
    await this.announce();
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
