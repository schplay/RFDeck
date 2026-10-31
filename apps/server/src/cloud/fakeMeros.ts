import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { canonicalJson } from './documents';
import type { CloudLink } from './link';
import type { MerosClient } from './merosClient';

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
  /** Cancel at the sign-in page instead of approving. */
  deny?: boolean;
  /** Who signs in at the sign-in page. */
  user?: { sub: string; name: string | null; email: string | null };
  /** Features the account's `rfdeck` entitlement carries. */
  features?: string[];
  /** When the entitlement expires. */
  expiresAt?: string | null;
  accountId?: string;
  kid?: string;
  /**
   * Answer `insufficient_scope` on the inventory endpoint.
   *
   * What an install linked before those scopes existed actually gets. Worth being
   * able to reproduce, because it is a 403 that means "re-link" rather than "pay".
   */
  withholdInventoryScope?: boolean;
  /** How long a redeemed login token may be redeemed again by the same client. Meros: 60 s. */
  ssoRedeemGraceMs?: number;
}

export class FakeMeros {
  private server: http.Server;
  /** Pushed authorization requests, by `request_uri`. */
  private pushed = new Map<string, URLSearchParams>();
  /** Authorization codes waiting to be exchanged. */
  private codes = new Map<string, { request: URLSearchParams }>();
  /** Live refresh tokens → the family they belong to. */
  private refreshTokens = new Map<string, string>();
  /** Families that have been revoked by a replay. */
  private revokedFamilies = new Set<string>();
  /** Refresh tokens that have been rotated away (replaying one is the breach). */
  private rotated = new Set<string>();
  private accessTokens = new Set<string>();
  /** Access token → the refresh family it was issued with, so revoking it cascades. */
  private accessFamilies = new Map<string, string>();
  /** Who each token family belongs to, for `/oauth/userinfo`. */
  private familyUsers = new Map<string, { sub: string; name: string | null; email: string | null }>();
  /** Login tokens minted for a service to redeem, by token. */
  private loginTokens = new Map<string, {
    challenge: string; nonce: string | null; clientId: string;
    sub: string; name: string | null; email: string | null; redeemedAt: number | null;
  }>();
  /** Access tokens revoked through /oauth/revoke, for assertions. */
  accessRevocations = 0;
  /** Refresh tokens revoked with the client named. */
  refreshRevocations = 0;
  /** Revoke requests that named no client, and so revoked nothing. */
  unidentifiedRevocations = 0;
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
  /** Packs this fake publishes, by name. */
  readonly packs = new Map<string, { payload: unknown; version: number; entitled: boolean }>();
  /** The account's inventory listing. Replaced wholesale by a PUT, as Meros does. */
  inventory: any[] = [];
  inventoryUpdatedAt: string | null = null;

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

  /**
   * Answer the sign-in page as the person would, standing in for the browser:
   * returns where meros.co sends the browser back to, with a code or, with
   * `deny`, the cancellation.
   */
  authorize(authorizeUrl: string): string {
    const requestUri = new URL(authorizeUrl).searchParams.get('request_uri') ?? '';
    const request = this.pushed.get(requestUri);
    if (!request) throw new Error(`No pushed request ${requestUri}`);
    this.pushed.delete(requestUri);
    const back = new URL(request.get('redirect_uri')!);
    back.searchParams.set('state', request.get('state') ?? '');
    back.searchParams.set('iss', this.baseUrl);
    if (this.options.deny) {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = crypto.randomBytes(16).toString('base64url');
      this.codes.set(code, { request });
      back.searchParams.set('code', code);
    }
    return back.toString();
  }

  /**
   * Link an instance to this fake the way a server does, through the browser
   * sign-in, with this fake answering the sign-in page. For tests of what a
   * linked instance does; the sign-in itself is tested in signIn.test.ts.
   */
  async link(meros: MerosClient, link: CloudLink): Promise<void> {
    const begun = await meros.run<{ authorize_url: string }>('signin.browser.begin', {
      redirect_uri: 'https://rack.lan:8443/api/cloud/signin/callback',
      client: 'server', server_client_id: link.config.clientId,
    }, link.session);
    await meros.run('signin.browser.finish', { callback_url: this.authorize(begun.authorize_url) }, link.session);
    await link.linked();
  }

  private idToken(clientId: string, user: { sub: string; name?: string | null; email?: string | null }, nonce: string | null) {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.baseUrl, aud: clientId, sub: user.sub, iat: now, exp: now + 3600, auth_time: now,
      ...(nonce ? { nonce } : {}),
      ...(user.name ? { name: user.name } : {}),
      ...(user.email ? { email: user.email, email_verified: true } : {}),
    };
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.fake-signature`;
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

  /**
   * Mint a login token the way Meros does for a console (`POST /oauth/sso/ticket`).
   *
   * Called directly by tests, standing in for the console: what matters on RFDeck's
   * side is the redeem, so the mint is modelled only as far as the redeem checks it.
   */
  mintLoginToken(opts: {
    codeChallenge: string; nonce?: string | null; clientId: string;
    sub: string; name?: string | null; email?: string | null;
  }): string {
    const token = crypto.randomBytes(32).toString('base64url');   // 43 characters, as Meros's are
    this.loginTokens.set(token, {
      challenge: opts.codeChallenge, nonce: opts.nonce ?? null, clientId: opts.clientId,
      sub: opts.sub, name: opts.name ?? null, email: opts.email ?? null, redeemedAt: null,
    });
    return token;
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
        pushed_authorization_request_endpoint: `${this.baseUrl}/oauth/par`,
        authorization_response_iss_parameter_supported: true,
        revocation_endpoint: `${this.baseUrl}/oauth/revoke`,
        userinfo_endpoint: `${this.baseUrl}/oauth/userinfo`,
        jwks_uri: `${this.baseUrl}/.well-known/jwks.json`,
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
    }

    // A pushed authorization request. The device signature is Meros's to check;
    // here only the parameters matter.
    if (path === '/oauth/par') {
      const form = new URLSearchParams(body);
      const requestUri = `urn:ietf:params:oauth:request_uri:${crypto.randomBytes(8).toString('hex')}`;
      this.pushed.set(requestUri, form);
      return send(201, { request_uri: requestUri, expires_in: 90 });
    }

    if (path === '/oauth/token') {
      const form = new URLSearchParams(body);
      const grant = form.get('grant_type');

      if (grant === 'authorization_code') {
        const entry = this.codes.get(form.get('code') ?? '');
        this.codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
        if (!entry
          || entry.request.get('client_id') !== form.get('client_id')
          || entry.request.get('redirect_uri') !== form.get('redirect_uri')
          || entry.request.get('code_challenge') !== challenge) {
          return send(400, { error: 'invalid_grant' });
        }
        const user = this.options.user ?? { sub: 'user-fake-1', name: 'Fake Owner', email: 'owner@example.test' };
        const family = `code-${crypto.randomBytes(4).toString('hex')}`;
        this.familyUsers.set(family, user);
        return send(200, {
          ...this.issue(family),
          scope: entry.request.get('scope') ?? '',
          id_token: this.idToken(entry.request.get('client_id')!, user, entry.request.get('nonce')),
        });
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

      if (grant === 'urn:meros:params:oauth:grant-type:sso-ticket') {
        const presented = form.get('login_token') ?? '';
        if (!presented) return send(400, { error: 'invalid_request', error_description: 'login_token is required.' });
        const ticket = this.loginTokens.get(presented);
        const verifier = form.get('code_verifier') ?? '';
        const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
        const graceMs = this.options.ssoRedeemGraceMs ?? 60_000;
        // One error for every ticket failure, as Meros does.
        const bad = !ticket
          || ticket.clientId !== form.get('client_id')
          || challenge !== ticket.challenge
          || (ticket.redeemedAt !== null && Date.now() - ticket.redeemedAt > graceMs);
        if (bad) return send(400, { error: 'invalid_grant', error_description: 'The login token is invalid.' });
        ticket!.redeemedAt ??= Date.now();

        this.familyUsers.set(`sso-${ticket!.sub}`, { sub: ticket!.sub, name: ticket!.name, email: ticket!.email });
        return send(200, {
          ...this.issue(`sso-${ticket!.sub}`),
          scope: form.get('scope') ?? '',
          id_token: this.idToken(ticket!.clientId, ticket!, ticket!.nonce),
        });
      }

      return send(400, { error: 'unsupported_grant_type' });
    }

    if (path === '/oauth/revoke') {
      const form = new URLSearchParams(body);
      const token = form.get('token') ?? '';
      // Meros revokes only when the request identifies the client (`client_id`
      // for a public client). Without it: 200, and nothing revoked — which is
      // exactly the failure a test has to be able to see.
      if (!form.get('client_id')) {
        this.unidentifiedRevocations += 1;
        return send(200, {});
      }
      const family = this.refreshTokens.get(token);
      if (family) {
        this.revokedFamilies.add(family);
        this.refreshRevocations += 1;
      }
      // Revoking an access token revokes its refresh token too, as Meros does.
      const accessFamily = this.accessFamilies.get(token);
      if (accessFamily) {
        this.revokedFamilies.add(accessFamily);
        this.accessTokens.delete(token);
        this.accessRevocations += 1;
      }
      return send(200, {});          // RFC 7009: always 200, never a probe oracle
    }

    // Who the bearer is: whoever signed in for the token's family.
    if (path === '/oauth/userinfo') {
      if (!this.authorized(req)) return send(401, { error: 'invalid_token' });
      const header = (req.headers.authorization as string | undefined) ?? '';
      const family = this.accessFamilies.get(header.replace(/^Bearer\s+/i, '')) ?? 'family-1';
      const user = this.familyUsers.get(family) ?? { sub: 'user-fake-1', name: 'Fake Owner', email: 'owner@example.test' };
      return send(200, { sub: user.sub, name: user.name, email: user.email });
    }

    if (path === '/v1/entitlements') {
      if (!this.authorized(req)) return send(401, { error: 'invalid_token' });
      // Honoured rather than ignored: an account may hold entitlements for several
      // products, and a client that asked for one should not receive the others.
      const wanted = new URL(req.url ?? '', 'http://x').searchParams.get('product');
      const accountId = this.options.accountId ?? 'acct-fake-1';
      if (wanted && wanted !== 'rfdeck') {
        return send(200, { product: wanted, account_id: accountId, features: { tier: 'free' }, entitlements: [] });
      }
      // Meros's shape: a flat map of the flags the account has, and the
      // entitlements they came from with their expiry.
      const features: Record<string, unknown> = { tier: 'pro' };
      for (const f of this.options.features ?? ['rfdeck.spectrum', 'rfdeck.backup.showfile']) features[f] = true;
      return send(200, {
        product: 'rfdeck',
        account_id: accountId,
        features,
        entitlements: [{
          sku: 'rfdeck-cloud',
          kind: 'subscription',
          status: 'active',
          expires_at: this.options.expiresAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
        }],
      });
    }

    // ── Signed data packs ──────────────────────────────────────────────────
    const feed = /^\/v1\/feeds\/rfdeck\/([A-Za-z0-9._-]+)$/.exec(path);
    if (feed) {
      const name = feed[1];
      const published = this.packs.get(name);
      if (!published) return send(404, { error: 'not_found', pack: name });
      if (published.entitled && !this.authorized(req)) {
        return send(403, { error: 'not_entitled' });
      }
      const etag = `"${name}-v${published.version}"`;
      // A weekly poll for something that has not changed should be one cheap
      // request, which is the whole point of the ETag.
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      return send(200, this.signPack(name, published.payload, published.version), { ETag: etag });
    }

    // ── The online inventory listing ───────────────────────────────────────
    //
    // A reconcile, like the real thing: a PUT replaces the whole set, so a device
    // absent from the body is gone. Modelled faithfully because that is the part
    // with teeth — a client that thought this merged would silently delete.
    if (path === '/v1/inventory/rfdeck') {
      if (!this.authorized(req)) return send(401, { error: 'invalid_token' });
      if (this.options.withholdInventoryScope) {
        // What a token minted before these scopes existed gets. Distinct from
        // `not_entitled`, and the two send an operator to different places.
        return send(403, { error: 'insufficient_scope', scope: 'inventory:write' });
      }
      if (req.method === 'GET') {
        return send(200, {
          product: 'rfdeck',
          count: this.inventory.length,
          updated_at: this.inventoryUpdatedAt,
          devices: this.inventory,
        });
      }
      if (req.method === 'PUT') {
        let parsed: any = null;
        try { parsed = JSON.parse(body); } catch { /* handled as bad_request below */ }
        if (!Array.isArray(parsed?.devices)) return send(400, { error: 'bad_request' });
        if (parsed.devices.length > 5000) return send(413, { error: 'inventory_too_large' });
        const missing = parsed.devices.findIndex((d: any) => !d || typeof d.id !== 'string' || !d.id);
        if (missing >= 0) {
          return send(422, {
            error: 'invalid_inventory',
            message: `devices[${missing}].id is required`,
          });
        }
        this.inventory = parsed.devices;
        this.inventoryUpdatedAt = new Date().toISOString();
        return send(200, {
          product: 'rfdeck', count: this.inventory.length, updated_at: this.inventoryUpdatedAt,
        });
      }
      return send(405, { error: 'method_not_allowed' });
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
    this.accessFamilies.set(access, family);
    this.refreshTokens.set(refresh, family);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
      scope: 'openid offline_access entitlements:read backups:read backups:write events:write'
        + ' inventory:read inventory:write',
    };
  }

  /** Publish a pack, or replace it with a new version. */
  publishPack(name: string, payload: unknown, options: { entitled?: boolean } = {}) {
    const existing = this.packs.get(name);
    this.packs.set(name, {
      payload,
      version: (existing?.version ?? 0) + 1,
      entitled: options.entitled ?? existing?.entitled ?? false,
    });
  }

  /** Force the next refresh to fail as a revoked family, as a Meros-side unlink would. */
  revokeEverything() {
    for (const family of this.refreshTokens.values()) this.revokedFamilies.add(family);
  }
}
