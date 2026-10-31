/**
 * The shapes RFDeck speaks to Meros Cloud.
 *
 * Internal, not a shared contract package: Meros is the source of truth for
 * these, and a formal versioned package is "not yet" per the hand-off. Keeping
 * them here means a shape correction is a one-file change rather than a package
 * release. See docs/CLOUD_INTEGRATION_PLAN.md.
 */

// ── Entitlements ────────────────────────────────────────────────────────────

export interface Entitlement {
  product: string;
  sku?: string;
  kind?: string;
  /** Namespaced `rfdeck.*` feature names. */
  features: string[];
  expires_at?: string | null;
}

export interface EntitlementsResponse {
  /** The account Meros resolved for this token. How RFDeck learns its own id. */
  account_id: string;
  issued_at: string;
  entitlements: Entitlement[];
}

/** What the UI is told about the link. */
export interface CloudStatus {
  configured: boolean;
  linked: boolean;
  accountId: string | null;
  linkedAt: string | null;
  lastRefreshAt: string | null;
  features: string[];
  expiresAt: string | null;
  /** True when the cloud is unreachable but a cached entitlement is still honoured. */
  offline: boolean;
  /** Set when the link is dead and needs re-establishing, with the reason. */
  needsRelink: string | null;
  /** Whether people can sign in to sync their preferences (the RFDeck Browser client is configured). */
  peopleCanSignIn: boolean;
  /** The Meros origin this install talks to. */
  baseUrl: string | null;
  /** Whether the event stream is being sent to the cloud. Off by default. */
  eventsToCloud: boolean;
  /** Events waiting to be sent, so an offline backlog is visible rather than silent. */
  eventsQueued: number;
}

// ── Events and alerts ───────────────────────────────────────────────────────
//
// Nothing here yet, on purpose. The `RelayAlert` shapes that used to live here
// were written against `POST /v1/alerts`, which Meros retracted on 2026-09-25:
// alerts are configured in the cloud over the *event* stream rather than posted
// to a relay endpoint, and the events-ingest contract is being reworked (moving
// off site tokens onto the instance link). Dead types invite use, so they are
// deleted rather than commented out. See docs/CLOUD_INTEGRATION_PLAN.md.
