import { log } from '../logger';

/**
 * Where Meros is, and who RFDeck is to it.
 *
 * All of this is per-environment and none of it is compiled in: staging and
 * production have different origins, different client ids and different signing
 * keys. In production the values arrive as systemd `Environment=` lines, the same
 * route `PORT` and `DATABASE_URL` already take; in development they are in
 * `apps/server/.env.local`, which is gitignored.
 *
 * A public OAuth client has no secret, so none of these are credentials — but a
 * production build that shipped a staging client id would still be broken, which
 * is reason enough for them to be configuration.
 */

export interface PackKey {
  /** Meros's key id, e.g. `rfdeck-2026a`. */
  kid: string;
  /** The raw 32-byte Ed25519 public key. */
  key: Buffer;
}

export interface CloudConfig {
  /** Origin OIDC discovery hangs off, without a trailing slash. */
  baseUrl: string;
  /** This install's client for the instance link (RFDeck Server or RFDeck Desktop). */
  clientId: string;
  /**
   * The RFDeck Browser client, for the person link. The server never uses it —
   * it hands it to the web UI, which runs its own device flow and keeps the
   * tokens in the browser.
   */
  browserClientId: string | null;
  /**
   * Meros's public signing keys for product `rfdeck`, by `kid`.
   *
   * A map rather than one key because rotation is additive: a future
   * `rfdeck-2026b` is published alongside `rfdeck-2026a`, so a build that has
   * been in a flight case keeps verifying while the new key rolls out.
   */
  packKeys: Map<string, Buffer>;
}

/** Scopes the instance link requests. Only what it actually uses. */
export const INSTANCE_SCOPES = [
  'openid',
  'offline_access',
  'entitlements:read',
  'backups:read',
  'backups:write',
  // Emitting the event stream. Alerts are configured in the cloud *over* these
  // events, so there is no alert scope and nothing for RFDeck to post to — the
  // `alerts:send` that briefly sat here belonged to a relay endpoint Meros
  // retracted on 2026-09-25.
  'events:write',
] as const;

/**
 * Scopes the person link requests.
 *
 * Deliberately no `offline_access`: the browser then holds no refresh token, so
 * nothing personal outlives the tab on a shared venue machine. The cost is
 * re-approving when the hour-long access token expires, which is the right trade
 * for a machine several people touch.
 */
export const PERSON_SCOPES = [
  'openid',
  'profile',
  'email',
  'profiles:read',
  'profiles:write',
] as const;

function parsePackKeys(spec: string | undefined): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const pair of (spec ?? '').split(',')) {
    const text = pair.trim();
    if (!text) continue;
    const eq = text.indexOf('=');
    if (eq <= 0) {
      log.warn(`[Cloud] Ignoring malformed MEROS_PACK_KEYS entry "${text}" — expected <kid>=<base64url>`);
      continue;
    }
    const kid = text.slice(0, eq).trim();
    const raw = Buffer.from(text.slice(eq + 1).trim(), 'base64url');
    // Ed25519 public keys are exactly 32 bytes. Anything else is a typo or a
    // different algorithm, and accepting it would mean failing later at
    // verification time with a much less obvious message.
    if (raw.length !== 32) {
      log.warn(
        `[Cloud] Ignoring signing key "${kid}": decoded to ${raw.length} bytes, ` +
        `expected 32 for Ed25519`,
      );
      continue;
    }
    out.set(kid, raw);
  }
  return out;
}

/**
 * Read the cloud configuration, or null when it is not configured.
 *
 * Null is the normal state, not a failure: RFDeck works entirely without the
 * cloud, and an install that has never heard of Meros should say "not
 * configured" rather than log an error on every boot.
 */
export function readCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  const baseUrl = env.MEROS_BASE_URL?.trim().replace(/\/+$/, '');
  const clientId = env.MEROS_CLIENT_ID?.trim();
  if (!baseUrl || !clientId) return null;

  if (!/^https:\/\//i.test(baseUrl)) {
    // Tokens travel over this. A plain-http origin is a configuration mistake
    // rather than a deployment choice, except against a local fake in tests.
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(baseUrl)) {
      log.warn(`[Cloud] MEROS_BASE_URL is not https (${baseUrl}) — refusing to use it`);
      return null;
    }
  }

  return {
    baseUrl,
    clientId,
    browserClientId: env.MEROS_CLIENT_ID_BROWSER?.trim() || null,
    packKeys: parsePackKeys(env.MEROS_PACK_KEYS),
  };
}
