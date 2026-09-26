import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';

/**
 * A fake Meros Cloud, in process.
 *
 * This is how the cloud client gets built and tested without a real cloud, and
 * it is the reason building ahead of a frozen contract is safe rather than
 * reckless. It follows the pattern already used by `e2e/serve.mjs`.
 *
 * Deliberately **hostile about refresh tokens**. It rotates on every use and, on
 * a replay of an already-rotated token, revokes the whole family exactly as
 * Meros does. That behaviour is the single most likely thing to break a real
 * venue at 19:45, and a test harness that is polite about it would let us ship
 * code that has never met it.
 *
 * It signs packs with the real `MEROSPACK1.…` construction, under a key pair it
 * generates, so the verifier is exercised end to end rather than only against
 * the committed vector.
 */

export interface FakeMerosOptions {
  /** Approve the device code automatically after this many polls. */
  approveAfterPolls?: number;
  /** Answer `slow_down` on the first poll. */
  slowDownOnce?: boolean;
  /** Deny the request instead of approving it. */
  deny?: boolean;
  /** Features the account's `rfdeck` entitlement carries. */
  features?: string[];
  /** When the entitlement expires. */
  expiresAt?: string | null;
  accountId?: string;
  kid?: string;
}

export class FakeMeros {
  private server: http.Server;
  private polls = 0;
  /** Live refresh tokens → the family they belong to. */
  private refreshTokens = new Map<string, string>();
  /** Families that have been revoked by a replay. */
  private revokedFamilies = new Set<string>();
  /** Refresh tokens that have been rotated away (replaying one is the breach). */
  private rotated = new Set<string>();
  private accessTokens = new Set<string>();
  private signingKey: crypto.KeyObject;

  readonly publicKeyBase64Url: string;
  readonly kid: string;
  /** Requests received, for assertions about scopes and headers. */
  readonly requests: { method: string; path: string; body: string; auth: string | null }[] = [];
  /** Set when a replay revoked a family — the thing a test wants to know happened. */
  familyRevocations = 0;

  constructor(private readonly options: FakeMerosOptions = {}) {
    const pair = crypto.generateKeyPairSync('ed25519');
    this.signingKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' }) as any;
    this.publicKeyBase64Url = jwk.x;
    this.kid = options.kid ?? 'rfdeck-fake';
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  get baseUrl(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Keys in the shape `readCloudConfig` produces, for wiring a verifier. */
  packKeys(): Map<string, Buffer> {
    return new Map([[this.kid, Buffer.from(this.publicKeyBase64Url, 'base64url')]]);
  }

  /** Sign a payload the way Meros does, so the real verifier can check it. */
  signPack(pack: string, payload: unknown, version = 1): Record<string, unknown> {
    const header = {
      product: 'rfdeck', pack, version, kid: this.kid,
      issued_at: new Date().toISOString(),
    };
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    const signed = `MEROSPACK1.${b64(header)}.${b64(payload)}`;
    const signature = crypto.sign(null, Buffer.from(signed, 'utf8'), this.signingKey);
    return { ...header, payload, signed, signature: signature.toString('base64url') };
  }

  // ── The endpoints ─────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await new Promise<string>(resolve => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => resolve(data));
    });
    const path = (req.url ?? '').split('?')[0];
    this.requests.push({
      method: req.method ?? 'GET',
      path,
      body,
      auth: (req.headers.authorization as string | undefined) ?? null,
    });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };

    if (path === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/oauth/authorize`,
        token_endpoint: `${this.baseUrl}/oauth/token`,
        device_authorization_endpoint: `${this.baseUrl}/oauth/device/code`,
        revocation_endpoint: `${this.baseUrl}/oauth/revoke`,
        userinfo_endpoint: `${this.baseUrl}/oauth/userinfo`,
        jwks_uri: `${this.baseUrl}/.well-known/jwks.json`,
        grant_types_supported: ['authorization_code', 'refresh_token', 'device_code'],
        code_challenge_methods_supported: ['S256'],
      });
    }

    if (path === '/oauth/device/code') {
      this.polls = 0;
      return send(200, {
        device_code: 'dev-code-1',
        user_code: 'WXYZ-1234',
        verification_uri: `${this.baseUrl}/link`,
        verification_uri_complete: `${this.baseUrl}/link?code=WXYZ-1234`,
        expires_in: 600,
        interval: 1,
      });
    }

    if (path === '/oauth/token') {
      const form = new URLSearchParams(body);
      const grant = form.get('grant_type');

      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        this.polls += 1;
        if (this.options.deny) return send(400, { error: 'access_denied' });
        if (this.options.slowDownOnce && this.polls === 1) return send(400, { error: 'slow_down' });
        if (this.polls < (this.options.approveAfterPolls ?? 1)) {
          return send(400, { error: 'authorization_pending' });
        }
        return send(200, this.issue('family-1'));
      }

      if (grant === 'refresh_token') {
        const presented = form.get('refresh_token') ?? '';

        // The breach path: this token was already rotated away. Meros does not
        // merely refuse it — it revokes the entire family.
        if (this.rotated.has(presented)) {
          const family = this.refreshTokens.get(presented) ?? 'family-1';
          this.revokedFamilies.add(family);
          this.familyRevocations += 1;
          for (const [token, fam] of this.refreshTokens) {
            if (fam === family) this.refreshTokens.delete(token);
          }
          return send(400, {
            error: 'invalid_grant',
            error_description: 'Refresh token reuse detected; the token family has been revoked.',
          });
        }

        const family = this.refreshTokens.get(presented);
        if (!family || this.revokedFamilies.has(family)) {
          return send(400, { error: 'invalid_grant', error_description: 'Unknown or revoked refresh token.' });
        }

        // Rotation: the presented token is retired and a new one issued.
        this.refreshTokens.delete(presented);
        this.rotated.add(presented);
        this.refreshTokens.set(presented, family);   // remembered, for replay detection
        return send(200, this.issue(family));
      }

      return send(400, { error: 'unsupported_grant_type' });
    }

    if (path === '/oauth/revoke') {
      const form = new URLSearchParams(body);
      const token = form.get('token') ?? '';
      const family = this.refreshTokens.get(token);
      if (family) this.revokedFamilies.add(family);
      return send(200, {});          // RFC 7009: always 200, never a probe oracle
    }

    if (path === '/v1/entitlements') {
      if (!this.authorized(req)) return send(401, { error: 'invalid_token' });
      return send(200, {
        account_id: this.options.accountId ?? 'acct-fake-1',
        issued_at: new Date().toISOString(),
        entitlements: [{
          product: 'rfdeck',
          sku: 'rfdeck-cloud',
          kind: 'subscription',
          features: this.options.features ?? ['rfdeck.regional-data', 'rfdeck.notify-relay'],
          expires_at: this.options.expiresAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
        }],
      });
    }

    return send(404, { error: 'not_found', path });
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = (req.headers.authorization as string | undefined) ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    return this.accessTokens.has(token);
  }

  private issue(family: string) {
    const access = `at-${crypto.randomUUID()}`;
    const refresh = `rt-${crypto.randomUUID()}`;
    this.accessTokens.add(access);
    this.refreshTokens.set(refresh, family);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
      scope: 'openid offline_access entitlements:read backups:read backups:write',
    };
  }

  /** Force the next refresh to fail as a revoked family, as a Meros-side unlink would. */
  revokeEverything() {
    for (const family of this.refreshTokens.values()) this.revokedFamilies.add(family);
  }
}
