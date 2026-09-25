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

// ── The alert relay (§8.5) ──────────────────────────────────────────────────

/** Meros's severity vocabulary, which is wider than RFDeck's own three levels. */
export type MerosSeverity = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

export interface RelayAlert {
  product: 'rfdeck';
  type: string;
  severity: MerosSeverity;
  /** The human sentence that reaches an email or a text. Must read alone. */
  message: string;
  instance?: string;
  subject?: { kind: string; id: string; name?: string };
  /** Free-form passthrough, forwarded to webhook targets. */
  context?: Record<string, unknown>;
  occurred_at?: string;
  dedupe_key?: string;
}

export interface RelayAlertResponse {
  accepted: boolean;
  account_id: string;
  dedupe_key: string;
  /**
   * How many of the account's rules will notify.
   *
   * Zero is normal and not an error: it means the account has configured no
   * matching rule. Treating it as a failure would put a warning in front of an
   * operator about something they may deliberately not want.
   */
  matched_rules: number;
}
