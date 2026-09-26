/**
 * The `rfdeck.*` entitlement flags, as Meros pins them.
 *
 * One list, shared by everything that gates, so a rename is one edit rather than a
 * search. Gating is enforced, and a flag string that does not match anything Meros
 * issues silently never matches — which presents as a feature missing from a paying
 * account rather than as the naming mismatch it is. So these are quoted from the
 * authoritative table and not paraphrased.
 *
 * **Absent is the expected state for most of them right now.** The names are pinned,
 * but the strategy at Meros that emits them is not built yet, so only
 * `SPECTRUM` is actually issued today (through the existing regional-data
 * entitlement check). Anything gated on the others will read as unavailable until
 * that ships — which is correct behaviour and worth knowing before somebody
 * reports it as a bug.
 */
export const FEATURES = {
  // ── Free tier ─────────────────────────────────────────────────────────────
  /** Whole-install snapshot: inventory, settings, audio routing, the roster. */
  BACKUP_CONFIG: 'rfdeck.backup.config',
  /** Show files. One, most recent only, without `BACKUP_HISTORY`. */
  BACKUP_SHOWFILE: 'rfdeck.backup.showfile',
  /** Email and webhook alerts, configured in the cloud over the event stream. */
  ALERTS_BASIC: 'rfdeck.alerts.basic',
  /** Person-scoped preference sync. Free and cross-product. */
  PROFILE: 'rfdeck.profile',

  // ── Individual (paid) ─────────────────────────────────────────────────────
  /** 100 versions, FIFO, instead of only the most recent. */
  BACKUP_HISTORY: 'rfdeck.backup.history',
  /** SMS as an alert channel. A Meros-side delivery choice, not an RFDeck capability. */
  ALERTS_SMS: 'rfdeck.alerts.sms',
  /** The FCC-derived TV-occupancy packs. The one flag actually issued today. */
  SPECTRUM: 'rfdeck.spectrum',
  RF_HISTORY: 'rfdeck.rf.history',
  RF_REPORTS: 'rfdeck.rf.reports',
  INVENTORY: 'rfdeck.inventory',

  // ── Paid, and only on an RFDeck Pro device ────────────────────────────────
  REMOTE_RESTORE: 'rfdeck.remote.restore',
  REMOTE_CONTROL: 'rfdeck.remote.control',
  AUDIT: 'rfdeck.audit',

  // ── Team add-on, account-level ────────────────────────────────────────────
  TEAM_FLEET: 'rfdeck.team.fleet',
  TEAM_ALERT_ROUTING: 'rfdeck.team.alert_routing',
  TEAM_MEMBERS: 'rfdeck.team.members',
} as const;

export type FeatureFlag = typeof FEATURES[keyof typeof FEATURES];

/**
 * Flags RFDeck itself checks, as opposed to ones Meros acts on.
 *
 * Most of the list above is not RFDeck's business: `ALERTS_SMS` is a delivery
 * channel Meros chooses, and the `TEAM_*` flags describe portal features. Naming
 * the ones we actually gate keeps the difference visible — and stops somebody
 * adding a check for a flag that was never meant to control anything here.
 */
export const GATED_BY_RFDECK: readonly FeatureFlag[] = [
  FEATURES.BACKUP_CONFIG,
  FEATURES.BACKUP_SHOWFILE,
  FEATURES.BACKUP_HISTORY,
  FEATURES.SPECTRUM,
  FEATURES.INVENTORY,
];
