import { useCloudStore } from '../stores/cloudStore';

/**
 * The single place the UI asks whether a paid cloud feature is available.
 *
 * One hook, so that when gating is switched on there is nothing to hunt for —
 * and so that the *reason* a control is off can be shown consistently. A gated
 * control is always rendered, disabled, with the reason: an operator should know
 * the feature exists and why it is not available, rather than wondering where it
 * went.
 *
 * **Gating is on since 2026-09-26**, when the tiers and prices were finalized. It
 * was off through development so nothing was walled off while there were no tiers
 * to enforce. `held` still reports what the account actually has, which is what a
 * status page should show rather than what the gate decided.
 */

/**
 * Must match `GATING_ENFORCED` in `apps/server/src/cloud/entitlements.ts`.
 *
 * Two constants rather than one served by the API, deliberately: the server is
 * the authority and enforces on every request, so this only decides whether the
 * UI *presents* something as gated. A client that disagreed would show a
 * disabled button the server would happily have honoured, which is a bug in one
 * direction only and a harmless one.
 */
const GATING_ENFORCED = true;

export interface Entitlement {
  /** Whether the feature may be used. */
  allowed: boolean;
  /** Whether the account genuinely holds it, regardless of the gate. */
  held: boolean;
  /** Why it is unavailable, ready to put in a `title`. Null when allowed. */
  reason: string | null;
}

export function useEntitled(feature: string): Entitlement {
  const status = useCloudStore(s => s.status);
  const held = status.features.includes(feature);

  if (!GATING_ENFORCED) return { allowed: true, held, reason: null };

  if (held) return { allowed: true, held, reason: null };

  const reason = !status.configured
    ? 'This is part of the paid cloud tier, and this server has no cloud configured.'
    : !status.linked
      ? 'This is part of the paid cloud tier. Link this rig in Settings → Cloud.'
      : status.offline
        ? 'Cannot confirm the subscription right now — Meros is unreachable. The last known answer is being used.'
        : 'This is part of the paid cloud tier. Add it to your account at meros.co.';

  return { allowed: false, held, reason };
}

/** Feature names, so a typo is a compile error rather than a silent false. */
export const FEATURES = {
  regionalData: 'rfdeck.regional-data',
  notifyRelay: 'rfdeck.notify-relay',
  batteryPrediction: 'rfdeck.battery-prediction',
  crossVenueRf: 'rfdeck.cross-venue-rf',
} as const;
