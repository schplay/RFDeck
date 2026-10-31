import { log } from '../logger';
import { CloudLink } from './link';

/**
 * The one place that answers "is this account entitled to X".
 *
 * Meros issues entitlements account-scoped with namespaced `rfdeck.*` feature
 * names. Reading, caching and the 30-day offline grace are the meros-client
 * helper's (`cloud.entitlements`): it keeps the last answer, honors it offline
 * and reports `held` — the features, or nothing once the grace has lapsed. What
 * stays RFDeck's is the decision: which features it gates, and that it gates at
 * all.
 */

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

/** The helper's `cloud.entitlements` answer. */
export interface EntitlementsAnswer {
  account_id: string | null;
  features: string[];
  tier: string;
  expires_at: string | null;
  held: string[];
  in_grace: boolean;
  lapsed: boolean;
  /** Unix seconds. */
  fetched_at: number;
  /** True when Meros could not be reached and this is the last answer. */
  cached: boolean;
}

export class Entitlements {
  private answer: EntitlementsAnswer | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly link: CloudLink,
    private readonly onChange: () => void = () => {},
  ) {}

  /**
   * Ask Meros, or the helper's cached answer when Meros is unreachable.
   *
   * Offline is not a failure: the cached copy carries on. The point of the cache
   * is a rig that has been in a flight case, so refusing to answer because the
   * network is down would defeat it.
   */
  async refresh(): Promise<EntitlementsAnswer | null> {
    try {
      // Scoped to this product: an account may pay for several Meros products
      // independently.
      const answer = await this.link.run<EntitlementsAnswer>('cloud.entitlements', { product: 'rfdeck' });
      this.answer = answer;
      this.lastError = answer.cached ? 'Meros is unreachable; using the last answer.' : null;
      log.debug(
        `[Cloud] Entitlements for account ${answer.account_id}: ` +
        `${answer.held.length ? answer.held.join(', ') : '(none)'}${answer.cached ? ' (cached)' : ''}`,
      );
      this.onChange();
    } catch (err) {
      this.lastError = (err as Error).message;
      log.debug(`[Cloud] Reading entitlements failed: ${(err as Error).message}`);
    }
    return this.answer;
  }

  /** Forget the answer, when the link goes. */
  clear() {
    this.answer = null;
    this.lastError = null;
  }

  /**
   * Does the account hold this feature? The honest answer, regardless of whether
   * gating is switched on.
   */
  async holds(feature: string): Promise<boolean> {
    return !!this.answer?.held.includes(feature);
  }

  /**
   * Should this feature be available? Whether the account holds it, while gating
   * is enforced.
   */
  async entitled(feature: string): Promise<boolean> {
    if (!GATING_ENFORCED) return true;
    return this.holds(feature);
  }

  snapshot() {
    return {
      accountId: this.answer?.account_id ?? null,
      features: this.answer?.held ?? [],
      expiresAt: this.answer?.expires_at ?? null,
      inGrace: this.answer?.in_grace ?? false,
      lapsed: this.answer?.lapsed ?? false,
      fetchedAt: this.answer ? new Date(this.answer.fetched_at * 1000).toISOString() : null,
      lastError: this.lastError,
    };
  }
}
