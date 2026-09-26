import { log } from '../logger';
import { CloudClient } from './client';
import { CloudLink } from './link';
import { EntitlementCache } from './linkStore';
import { EntitlementsResponse } from './types';

/**
 * The one place that answers "is this account entitled to X".
 *
 * Entitlements are data, verified and then cached, so the answer survives a rig
 * with no internet. Meros issues them account-scoped with namespaced `rfdeck.*`
 * feature names; RFDeck consumes that and does not invent a format.
 *
 * **Gating is deferred by owner decision.** The plumbing and the gate are built;
 * nothing is walled off yet, and features are granted liberally while testing.
 * `entitled()` is written so that turning enforcement on later is a change to
 * one constant rather than a hunt through the codebase.
 */

/** How long a cached entitlement is honoured after it expires with no refresh. */
const GRACE_MS = 30 * 24 * 60 * 60_000;

/**
 * Whether a missing entitlement actually withholds anything.
 *
 * **True since 2026-09-26**, when the cloud tiers and prices were finalized. It was
 * false through development so that nothing was walled off while there were no
 * tiers to enforce; the point of there being exactly one of these is that turning
 * it on was a one-line change rather than a hunt.
 *
 * `holds()` still reports the honest answer alongside `entitled()`, so a status
 * page shows what an account actually has rather than what the gate decided.
 *
 * Note what this does *not* affect: an install with no cloud configured, or one
 * that is not linked, is not gated. A paywall appearing because somebody has not
 * signed in would be a paywall nobody asked for — and for the features this gates,
 * an unlinked rig has no cloud data to withhold anyway.
 */
export const GATING_ENFORCED = true;

interface CachedEntitlements {
  accountId: string;
  issuedAt: string;
  features: string[];
  /** The soonest expiry across the account's rfdeck entitlements, if any. */
  expiresAt: string | null;
  /** When RFDeck last successfully read this from Meros. */
  fetchedAt: string;
}

export class Entitlements {
  private cache: CachedEntitlements | null = null;
  private loaded = false;
  private lastError: string | null = null;

  constructor(
    private readonly client: CloudClient,
    private readonly link: CloudLink,
    private readonly cache_: EntitlementCache,
    private readonly onChange: () => void = () => {},
  ) {}

  /** Read the cached statement from the database once per process. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const stored = await this.cache_.read();
    if (!stored) return;
    try {
      this.cache = JSON.parse(stored);
    } catch {
      log.warn('[Cloud] Cached entitlements are unreadable — ignoring them');
    }
  }

  /**
   * Fetch from Meros and cache.
   *
   * Offline is not a failure: the cached copy carries on. The point of the cache
   * is a rig that has been in a flight case, so refusing to answer because the
   * network is down would defeat it.
   */
  async refresh(): Promise<CachedEntitlements | null> {
    await this.load();
    let token: string;
    try {
      token = await this.link.token();
    } catch (err) {
      this.lastError = (err as Error).message;
      return this.cache;
    }

    try {
      // Scoped to this product: an account may pay for several Meros products
      // independently, and asking for all of them then filtering would make
      // RFDeck's own entitlements depend on how much unrelated data came back.
      const res = await this.client.json<EntitlementsResponse>(
        'GET', `${this.client.baseUrl}/v1/entitlements?product=rfdeck`, { token },
      );
      const mine = (res.entitlements ?? []).filter(e => e.product === 'rfdeck');
      const features = [...new Set(mine.flatMap(e => e.features ?? []))].sort();
      const expiries = mine
        .map(e => e.expires_at)
        .filter((v): v is string => !!v)
        .sort();

      this.cache = {
        accountId: res.account_id,
        issuedAt: res.issued_at,
        features,
        expiresAt: expiries[0] ?? null,
        fetchedAt: new Date().toISOString(),
      };
      this.lastError = null;

      // `account_id` is how RFDeck learns which account it is acting in: the
      // instance token is user-scoped rather than account-pinned, so this is
      // the resolved answer rather than something the token carried.
      await this.cache_.write(res.account_id, JSON.stringify(this.cache));
      log.debug(
        `[Cloud] Entitlements for account ${res.account_id}: ` +
        `${features.length ? features.join(', ') : '(none)'}`,
      );
      this.onChange();
      return this.cache;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.client.logOnce('Reading entitlements failed', err);
      return this.cache;
    }
  }

  /** True while a cached statement is being honoured past its expiry. */
  private inGrace(): boolean {
    if (!this.cache?.expiresAt) return false;
    const expired = Date.parse(this.cache.expiresAt);
    return Number.isFinite(expired) && Date.now() > expired && Date.now() < expired + GRACE_MS;
  }

  /** Whether the cached statement is too old to honour at all. */
  private lapsed(): boolean {
    if (!this.cache?.expiresAt) return false;
    const expired = Date.parse(this.cache.expiresAt);
    return Number.isFinite(expired) && Date.now() > expired + GRACE_MS;
  }

  /**
   * Does the account hold this feature? The honest answer, regardless of whether
   * gating is switched on.
   */
  async holds(feature: string): Promise<boolean> {
    await this.load();
    if (!this.cache || this.lapsed()) return false;
    return this.cache.features.includes(feature);
  }

  /**
   * Should this feature be available?
   *
   * While gating is deferred this is always true — build the gate, wall nothing
   * off. One constant flips it, so the day enforcement arrives there is no
   * scattered set of checks to find.
   */
  async entitled(feature: string): Promise<boolean> {
    if (!GATING_ENFORCED) return true;
    return this.holds(feature);
  }

  async snapshot() {
    await this.load();
    return {
      accountId: this.cache?.accountId ?? null,
      features: this.cache?.features ?? [],
      expiresAt: this.cache?.expiresAt ?? null,
      inGrace: this.inGrace(),
      lapsed: this.lapsed(),
      lastError: this.lastError,
    };
  }
}
