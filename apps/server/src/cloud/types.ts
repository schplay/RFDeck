/**
 * The shapes RFDeck speaks to Meros Cloud.
 *
 * Internal, not a shared contract package: Meros is the source of truth for
 * these, and a formal versioned package is "not yet" per the hand-off. Keeping
 * them here means a shape correction is a one-file change rather than a package
 * release. See docs/CLOUD_INTEGRATION_PLAN.md.
 */

// ── Discovery ───────────────────────────────────────────────────────────────

export interface MerosDiscovery {
  issuer?: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  revocation_endpoint?: string;
  userinfo_endpoint?: string;
  authorization_endpoint?: string;
  jwks_uri?: string;
  grant_types_supported?: string[];
}

// ── Device grant (RFC 8628) ─────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  /** Seconds between polls. Absent means 5, per RFC 8628 §3.2. */
  interval?: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

/** The errors RFC 8628 §3.5 defines for polling, plus what Meros adds. */
export type DeviceTokenError =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant'
  | string;

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
  /** The browser's own client id, for the person link's device flow. */
  browserClientId: string | null;
  baseUrl: string | null;
}

// ── Events and alerts ───────────────────────────────────────────────────────
//
// Nothing here yet, on purpose. The `RelayAlert` shapes that used to live here
// were written against `POST /v1/alerts`, which Meros retracted on 2026-09-25:
// alerts are configured in the cloud over the *event* stream rather than posted
// to a relay endpoint, and the events-ingest contract is being reworked (moving
// off site tokens onto the instance link). Dead types invite use, so they are
// deleted rather than commented out. See docs/CLOUD_INTEGRATION_PLAN.md.
