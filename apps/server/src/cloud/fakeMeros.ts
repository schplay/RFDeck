import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { canonicalJson } from './documents';

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
  /** Events received, keyed (source.instance, id) so dedupe is real. */
  readonly events = new Map<string, any>();
  /** Documents, by "collection/key". Versioned the way Meros versions them. */
  readonly documents = new Map<string, { version: number; body: any; updated_at: string; hash: string }[]>();
  private signingKey: crypto.KeyObject;

  readonly publicKeyBase64Url: string;
  readonly kid: string;
  /** Requests received, for assertions about scopes and headers. */
  readonly requests: { method: string; path: string; body: string; auth: string | null }[] = [];
  /** Set when a replay revoked a family — the thing a test wants to know happened. */
  familyRevocations = 0;
  /** Soft-deleted document paths — history is kept, the key leaves the listing. */
  readonly deletedDocuments = new Set<string>();

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

    // ── Document sync ──────────────────────────────────────────────────────
    const docs = /^\/v1\/docs\/rfdeck\/([^/]+)(?:\/([^/]+))?(\/versions)?$/.exec(path);
    if (docs) {
      if (!this.authorized(req)) return send(401, { error: 'invalid_token' });
      const collection = decodeURIComponent(docs[1]);
      const key = docs[2] ? decodeURIComponent(docs[2]) : null;
      const wantsVersions = !!docs[3];

      if (!key) {
        const documents = [...this.documents.entries()]
          .filter(([p]) => p.startsWith(`${collection}/`) && !this.deletedDocuments.has(p))
          .map(([p, versions]) => ({
            key: p.slice(collection.length + 1),
            head_version: versions[versions.length - 1].version,
            updated_at: versions[versions.length - 1].updated_at,
          }))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return send(200, {
          account_id: this.options.accountId ?? 'acct-fake-1',
          product: 'rfdeck', collection, documents,
        });
      }

      const full = `${collection}/${key}`;
      const versions = this.documents.get(full);

      if (req.method === 'GET' && wantsVersions) {
        if (!versions) return send(404, { error: 'not_found' });
        return send(200, {
          versions: versions.map(v => ({
            version: v.version, content_hash: v.hash,
            size_bytes: JSON.stringify(v.body).length, created_at: v.updated_at,
            author_user_id: 'user-fake-1',
          })),
        });
      }

      if (req.method === 'GET') {
        if (!versions) return send(404, { error: 'not_found' });
        const wanted = new URL(req.url ?? '', 'http://x').searchParams.get('version');
        const found = wanted
          ? versions.find(v => v.version === Number(wanted))
          : versions[versions.length - 1];
        if (!found) return send(404, { error: 'not_found' });
        // The guaranteed envelope: the document in `body`, Meros's metadata
        // alongside it. `head_version` is how a client knows it fetched an older
        // version on purpose.
        return send(200, {
          key,
          version: found.version,
          head_version: versions[versions.length - 1].version,
          content_hash: found.hash,
          size_bytes: JSON.stringify(found.body).length,
          created_at: found.updated_at,
          body: found.body,
        });
      }

      if (req.method === 'PUT') {
        const payload = body ? JSON.parse(body) : {};
        if (!payload.body || typeof payload.body !== 'object') {
          return send(422, { error: 'invalid_body', message: '`body` must be an object.' });
        }
        const encoded = JSON.stringify(payload.body);
        if (encoded.length > 1024 * 1024) {
          return send(413, { error: 'document_too_large' });
        }
        const head = versions?.[versions.length - 1] ?? null;
        const headVersion = head?.version ?? 0;
        const base = payload.base_version ?? 0;
        if (base !== headVersion) {
          // Meros answers 409 with the head attached, so the client can offer a
          // real choice rather than just reporting a conflict.
          return send(409, {
            error: 'version_conflict',
            message: 'The head has moved since that version.',
            head: head
              ? { version: head.version, updated_at: head.updated_at, content_hash: head.hash }
              : { version: 0, updated_at: null, content_hash: null },
          });
        }
        this.deletedDocuments.delete(full);
        // The canonical hash, exactly as Meros computes it: keys sorted
        // recursively, array order kept, no whitespace. Hashing `encoded` here
        // instead would make the fake agree with our client for the wrong
        // reason, and hide the very mismatch this is meant to catch.
        const hash = crypto.createHash('sha256')
          .update(canonicalJson(payload.body), 'utf8').digest('hex');
        const next = {
          version: headVersion + 1, body: payload.body,
          updated_at: new Date().toISOString(), hash,
        };
        if (versions) versions.push(next); else this.documents.set(full, [next]);
        // 201, and the same envelope as a GET without `body`.
        return send(201, {
          key,
          version: next.version,
          head_version: next.version,
          content_hash: hash,
          size_bytes: encoded.length,
          created_at: next.updated_at,
        });
      }

      if (req.method === 'DELETE') {
        // Soft: history is retained and a later PUT revives the version line.
        this.deletedDocuments.add(full);
        return send(200, { deleted: true });
      }
    }

    if (path === '/v1/events') {
      if (!this.authorized(req)) return send(401, { error: 'invalid_token' });
      const parsed = body ? JSON.parse(body) : null;
      const batch: any[] = Array.isArray(parsed) ? parsed : [parsed];
      if (batch.length > 500) {
        return send(400, { error: 'batch_too_large', message: 'At most 500 events per request.' });
      }
      let accepted = 0, duplicates = 0, rejected = 0;
      const errors: { id?: string; reason: string }[] = [];
      for (const event of batch) {
        // The collector dedupes on (source.instance, id) — the emitter's ULID is
        // the idempotency key, so a retried batch must not double-count.
        const key = `${event?.source?.instance}|${event?.id}`;
        if (!event?.id || !event?.occurred_at || !event?.type || !event?.source?.product) {
          rejected += 1;
          errors.push({ id: event?.id, reason: 'missing a required envelope field' });
        } else if (this.events.has(key)) {
          duplicates += 1;
        } else {
          this.events.set(key, event);
          accepted += 1;
        }
      }
      return send(202, { accepted, duplicates, rejected, errors });
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
      scope: 'openid offline_access entitlements:read backups:read backups:write events:write',
    };
  }

  /** Force the next refresh to fail as a revoked family, as a Meros-side unlink would. */
  revokeEverything() {
    for (const family of this.refreshTokens.values()) this.revokedFamilies.add(family);
  }
}
