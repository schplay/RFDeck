import { log } from '../logger';
import { Feeds } from './feeds';

/**
 * Device-profile updates, as a signed pack.
 *
 * The band tables shipped in `hardware/coordination/profiles.ts` are the baseline;
 * this feed delivers corrections and additions as data, so a new band or a
 * verified figure does not need a release. The profile module already records
 * which of its numbers are *assumed* rather than read from a manufacturer's
 * documentation, and this feed is where "read" comes from over time.
 *
 * **Public pack, so no link is needed.** An unlinked rig — one that has never
 * heard of Meros — still stays current on band tables, which is the right outcome:
 * this is a data-quality baseline, not a premium feature. That makes it the one
 * cloud feature that does something useful for an operator who never signs in.
 *
 * An override only ever *narrows* uncertainty. It can correct a figure and mark an
 * assumed one as verified; it cannot mark a verified figure as assumed, and it
 * cannot introduce a family the build does not know how to coordinate for.
 */

export const DEVICE_PROFILE_PACK = 'device-profiles';

export interface ProfileOverride {
  /** A coordination family the build already knows, e.g. `shure-ulxd`. */
  family: string;
  stepKHz?: number;
  spacingKHz?: { standard?: number; dense?: number };
  /** Which figures are still assumptions after this override. */
  assumed?: Array<'step' | 'spacing'>;
  /** Where the corrected figure came from, for the operator to judge. */
  source?: string;
}

export interface DeviceProfilePack {
  generated_at?: string;
  overrides: ProfileOverride[];
}

export interface AppliedProfiles {
  overrides: Map<string, ProfileOverride>;
  generatedAt: string | null;
  fetchedAt: string | null;
  /** Overrides refused, with why — so a bad pack is visible rather than silent. */
  rejected: { family: string; reason: string }[];
}

const EMPTY: AppliedProfiles = {
  overrides: new Map(), generatedAt: null, fetchedAt: null, rejected: [],
};

export class DeviceProfiles {
  private applied: AppliedProfiles = EMPTY;

  constructor(
    private readonly feeds: Feeds,
    /** The families this build can coordinate for. An override for any other is refused. */
    private readonly knownFamilies: ReadonlySet<string>,
  ) {}

  get current(): AppliedProfiles {
    return this.applied;
  }

  /** Fetch and apply. Soft-fails: without the pack, the shipped tables stand. */
  async refresh(): Promise<AppliedProfiles> {
    try {
      const pack = await this.feeds.fetch<DeviceProfilePack>(DEVICE_PROFILE_PACK);
      this.applied = this.validate(pack.payload, pack.fetchedAt);
      log.info(
        `[Cloud] Device profiles: ${this.applied.overrides.size} override(s) applied` +
        (this.applied.rejected.length ? `, ${this.applied.rejected.length} refused` : ''),
      );
    } catch (err) {
      // No pack is the normal state until Meros publishes one, and an offline rig
      // keeps whatever it cached. The shipped tables are always a working answer.
      log.debug(`[Cloud] No device-profile pack applied: ${(err as Error).message}`);
      const cached = this.feeds.cachedOnly<DeviceProfilePack>(DEVICE_PROFILE_PACK);
      if (cached) this.applied = this.validate(cached.payload, cached.fetchedAt);
    }
    return this.applied;
  }

  /** Load from cache without touching the network. */
  loadCached(): AppliedProfiles {
    const cached = this.feeds.cachedOnly<DeviceProfilePack>(DEVICE_PROFILE_PACK);
    this.applied = cached ? this.validate(cached.payload, cached.fetchedAt) : EMPTY;
    return this.applied;
  }

  /**
   * Check every override before it can affect a coordination plan.
   *
   * A signature proves a pack came from Meros; it does not prove the numbers in it
   * are sane. These are figures a solver will place transmitters on, so a nonsense
   * step or a spacing narrower than the step would produce a plan that looks
   * authoritative and is not.
   */
  private validate(pack: DeviceProfilePack, fetchedAt: string | null): AppliedProfiles {
    const overrides = new Map<string, ProfileOverride>();
    const rejected: { family: string; reason: string }[] = [];

    for (const raw of pack?.overrides ?? []) {
      const family = typeof raw?.family === 'string' ? raw.family : '';
      if (!family) {
        rejected.push({ family: '(unnamed)', reason: 'no family named' });
        continue;
      }
      if (!this.knownFamilies.has(family)) {
        // A family this build cannot coordinate for is not an error in the pack —
        // it is a newer pack than the build. Recorded, not applied.
        rejected.push({ family, reason: 'this build has no coordination rules for that family' });
        continue;
      }

      const step = raw.stepKHz;
      if (step !== undefined && (!Number.isFinite(step) || step <= 0 || step > 10_000)) {
        rejected.push({ family, reason: `implausible tuning step (${step} kHz)` });
        continue;
      }
      const standard = raw.spacingKHz?.standard;
      const dense = raw.spacingKHz?.dense;
      for (const [label, value] of [['standard', standard], ['dense', dense]] as const) {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 100_000)) {
          rejected.push({ family, reason: `implausible ${label} spacing (${value} kHz)` });
        }
      }
      if (rejected.some(r => r.family === family)) continue;

      // Dense spacing is the tighter one by definition. The other way round would
      // silently widen a High Density plan instead of tightening it.
      if (standard !== undefined && dense !== undefined && dense > standard) {
        rejected.push({ family, reason: 'dense spacing is wider than standard' });
        continue;
      }

      overrides.set(family, {
        family,
        ...(step !== undefined ? { stepKHz: step } : {}),
        ...(raw.spacingKHz ? { spacingKHz: raw.spacingKHz } : {}),
        // Only ever narrows uncertainty: a pack may say a figure is now verified,
        // never that a verified one has become an assumption.
        ...(Array.isArray(raw.assumed)
          ? { assumed: raw.assumed.filter(a => a === 'step' || a === 'spacing') }
          : {}),
        ...(typeof raw.source === 'string' ? { source: raw.source } : {}),
      });
    }

    for (const r of rejected) {
      log.warn(`[Cloud] Device-profile override for ${r.family} refused: ${r.reason}`);
    }
    return {
      overrides,
      generatedAt: typeof pack?.generated_at === 'string' ? pack.generated_at : null,
      fetchedAt,
      rejected,
    };
  }
}
