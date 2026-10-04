import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { FakeMeros } from './fakeMeros';
import { CloudClient, CloudOffline } from './client';
import { CloudConfig } from './config';
import { CloudUserLogin, CloudLoginError, s256, checkIdToken } from './cloudUser';
import { MemoryCloudUserStore } from './cloudUserStore';
import { cloudLoginRoutes } from '../routes/cloudLogin';

// Signing a Meros cloud user in on this install, from Manifold, against a fake
// Meros that implements the login-token redeem the way meros.co documents it:
// single use, a 60-second grace for the same client, PKCE checked, one
// `invalid_grant` for every ticket failure.
//
// The test plays Manifold: it calls `begin`, mints the login token at the fake
// with the challenge and nonce it was given, and calls `complete`.

const CLOUD_USER_CLIENT = 'rfdeck-cloud-user-test';
const SUB = '0b9a3f6e-6a6b-4d5e-9a3f-1f2e3d4c5b6a';
const OTHER_SUB = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

let fake: FakeMeros | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

async function harness(options: { cloudUserClientId?: string | null } = {}) {
  fake = new FakeMeros();
  const baseUrl = await fake.listen();
  const config: CloudConfig = {
    baseUrl,
    clientId: 'rfdeck-server-test',
    browserClientId: null,
    cloudUserClientId: 'cloudUserClientId' in options ? options.cloudUserClientId : CLOUD_USER_CLIENT,
    packKeys: new Map(),
  };
  const client = new CloudClient(config);
  const store = new MemoryCloudUserStore();
  const login = new CloudUserLogin(config, client, store);
  return { fake: fake!, config, client, store, login };
}

/** Manifold's half: mint a login token at Meros for what `begin` returned. */
function mint(f: FakeMeros, begun: { codeChallenge: string; nonce: string },
              who: { sub?: string; name?: string; email?: string; clientId?: string } = {}) {
  return f.mintLoginToken({
    codeChallenge: begun.codeChallenge,
    nonce: begun.nonce,
    clientId: who.clientId ?? CLOUD_USER_CLIENT,
    sub: who.sub ?? SUB,
    name: who.name ?? 'Alex Example',
    email: who.email ?? 'alex@example.test',
  });
}

const redeemRequests = (f: FakeMeros) =>
  f.requests.filter(r => r.path === '/oauth/token'
    && new URLSearchParams(r.body).get('grant_type') === 'urn:meros:params:oauth:grant-type:sso-ticket');

describe('beginning a sign-in', () => {
  it('hands out an S256 challenge and a nonce, and never the verifier', async () => {
    const { login } = await harness();
    const begun = login.begin();
    expect(begun.codeChallengeMethod).toBe('S256');
    expect(begun.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);   // base64url SHA-256, no padding
    expect(begun.nonce.length).toBeGreaterThan(10);
    expect(Object.values(begun).join(' ')).not.toMatch(/verifier/i);
  });

  it('refuses when the Cloud User client is not configured, rather than half-working', async () => {
    const { login } = await harness({ cloudUserClientId: null });
    expect(() => login.begin()).toThrowError(CloudLoginError);
    try { login.begin(); } catch (e) { expect((e as CloudLoginError).status).toBe(503); }
  });
});

describe('completing a sign-in', () => {
  it('signs the cloud user in, keyed on sub, with a refresh token stored', async () => {
    const { fake, login, store } = await harness();
    const begun = login.begin();
    const session = await login.complete(begun.requestId, mint(fake, begun));

    expect(session.signedIn).toBe(true);
    expect(session.user).toEqual({ sub: SUB, name: 'Alex Example', email: 'alex@example.test' });
    expect(session.signedInVia).toBe('manifold');
    expect((await store.read())?.refreshToken).toMatch(/^rt-/);
  });

  it('redeems as RFDeck Cloud User with the verifier and its own scopes', async () => {
    // Its own client, not the instance link's: the two refresh families must not
    // be able to revoke each other.
    const { fake, login } = await harness();
    const begun = login.begin();
    await login.complete(begun.requestId, mint(fake, begun));

    const form = new URLSearchParams(redeemRequests(fake)[0].body);
    expect(form.get('client_id')).toBe(CLOUD_USER_CLIENT);
    expect(form.get('client_id')).not.toBe('rfdeck-server-test');
    expect(s256(form.get('code_verifier')!)).toBe(begun.codeChallenge);
    expect(form.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining(['openid', 'profile', 'email', 'profiles:read', 'profiles:write']),
    );
  });

  it('cannot be completed with a login token minted for a different challenge', async () => {
    // What a login token taken off the wire, or kept by the console, looks like
    // from here: it was not minted against this request's verifier.
    const { fake, login, store } = await harness();
    const mine = login.begin();
    const someoneElses = login.begin();
    await expect(login.complete(mine.requestId, mint(fake, someoneElses)))
      .rejects.toMatchObject({ status: 401, code: 'invalid_grant' });
    expect(await store.read()).toBeNull();
  });

  it('cannot be completed for a request that was never begun', async () => {
    const { login } = await harness();
    await expect(login.complete('never-begun', 'whatever'))
      .rejects.toMatchObject({ status: 404, code: 'unknown_request' });
  });

  it('cannot be completed twice', async () => {
    const { fake, login } = await harness();
    const begun = login.begin();
    const token = mint(fake, begun);
    await login.complete(begun.requestId, token);
    await expect(login.complete(begun.requestId, token))
      .rejects.toMatchObject({ status: 404 });
  });

  it('survives Meros being unreachable, and completes on a retry', async () => {
    const { fake, login, client } = await harness();
    const begun = login.begin();
    const token = mint(fake, begun);

    vi.spyOn(client, 'json').mockRejectedValueOnce(new CloudOffline('ECONNRESET'));
    await expect(login.complete(begun.requestId, token))
      .rejects.toMatchObject({ status: 502, code: 'meros_unreachable' });

    const session = await login.complete(begun.requestId, token);
    expect(session.signedIn).toBe(true);
  });

  it('recovers when storing the sign-in fails after Meros has already redeemed it', async () => {
    // Meros has spent the login token; the 60 s grace lets the same client redeem
    // it again, so the request must still be answerable.
    const { fake, login, store } = await harness();
    const begun = login.begin();
    const token = mint(fake, begun);

    vi.spyOn(store, 'signIn').mockRejectedValueOnce(new Error('disk full'));
    await expect(login.complete(begun.requestId, token)).rejects.toThrow('disk full');

    const session = await login.complete(begun.requestId, token);
    expect(session.signedIn).toBe(true);
    expect(redeemRequests(fake)).toHaveLength(2);
  });

  it('refuses, and revokes what it was given, when the id_token is not for this sign-in', async () => {
    const { fake, login, store } = await harness();
    const begun = login.begin();
    const token = fake.mintLoginToken({
      codeChallenge: begun.codeChallenge, nonce: 'a-different-nonce',
      clientId: CLOUD_USER_CLIENT, sub: SUB,
    });
    await expect(login.complete(begun.requestId, token))
      .rejects.toMatchObject({ status: 502, code: 'invalid_response' });
    expect(await store.read()).toBeNull();
    expect(fake.accessRevocations).toBe(1);
  });

  it('replaces a different cloud user who was signed in, and says so', async () => {
    const { fake, login } = await harness();
    const first = login.begin();
    await login.complete(first.requestId, mint(fake, first));

    const second = login.begin();
    const session = await login.complete(second.requestId, mint(fake, second, { sub: OTHER_SUB, email: 'sam@example.test' }));
    expect(session.replacedPrevious).toBe(true);
    expect(session.user?.sub).toBe(OTHER_SUB);
  });
});

describe('the signed-in session', () => {
  it('rotates the refresh token, storing it before the access token is used', async () => {
    const { fake, login, store } = await harness();
    const begun = login.begin();
    await login.complete(begun.requestId, mint(fake, begun));
    const firstRefresh = (await store.read())!.refreshToken;

    (login as any).accessToken = null;           // the hour is up
    const access = await login.token();

    expect(access).toMatch(/^at-/);
    expect(store.writes).toHaveLength(2);
    expect(store.writes[1]).not.toBe(firstRefresh);
    expect((await store.read())!.refreshToken).toBe(store.writes[1]);
  });

  it('shares one refresh between concurrent callers, so it never looks like a replay', async () => {
    const { fake, login } = await harness();
    const begun = login.begin();
    await login.complete(begun.requestId, mint(fake, begun));
    (login as any).accessToken = null;

    await Promise.all([login.token(), login.token(), login.token()]);
    expect(fake.familyRevocations).toBe(0);
  });

  it('ends the session, with a reason, when Meros refuses the refresh', async () => {
    const { fake, login } = await harness();
    const begun = login.begin();
    await login.complete(begun.requestId, mint(fake, begun));

    fake.revokeEverything();
    (login as any).accessToken = null;
    await expect(login.token()).rejects.toMatchObject({ code: 'invalid_grant' });

    const session = await login.session();
    expect(session.signedIn).toBe(false);
    expect(session.signedOutReason).toMatch(/Sign in again/);
  });
});

describe('signing out', () => {
  it('ends the sign-in at Meros, not just here', async () => {
    // Meros answers 200 to a revoke that does not name the client and revokes
    // nothing, so "the request succeeded" proves nothing. What is asserted is the
    // outcome: the refresh token this install held no longer works at Meros.
    const { fake, login, store, client } = await harness();
    const begun = login.begin();
    await login.complete(begun.requestId, mint(fake, begun));
    const held = (await store.read())!.refreshToken!;

    const result = await login.signOut();
    expect(result).toEqual({ signedIn: false, revoked: true });
    expect(await store.read()).toBeNull();
    expect(fake.unidentifiedRevocations).toBe(0);

    await expect(client.json('POST', await client.tokenEndpoint(), {
      form: { grant_type: 'refresh_token', refresh_token: held, client_id: CLOUD_USER_CLIENT },
    })).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('forgets locally even when Meros cannot be reached', async () => {
    const { fake, login, store, client } = await harness();
    const begun = login.begin();
    await login.complete(begun.requestId, mint(fake, begun));

    vi.spyOn(client, 'json').mockRejectedValue(new CloudOffline('ENETUNREACH'));
    const result = await login.signOut();
    expect(result.revoked).toBe(false);
    expect(await store.read()).toBeNull();
  });
});

describe('id_token checks', () => {
  const ok = { clientId: 'c', nonce: 'n', issuer: 'https://meros.test' };
  const claims = { aud: 'c', sub: SUB, nonce: 'n', iss: 'https://meros.test', exp: Date.now() / 1000 + 600 };

  it('accept a token for this client, this sign-in and this issuer', () => {
    expect(checkIdToken(claims, ok)).toBeNull();
  });

  it('refuse each way it can be wrong', () => {
    expect(checkIdToken(null, ok)).toMatch(/no readable/);
    expect(checkIdToken({ ...claims, aud: 'other' }, ok)).toMatch(/different client/);
    expect(checkIdToken({ ...claims, sub: '' }, ok)).toMatch(/no sub/);
    expect(checkIdToken({ ...claims, nonce: 'x' }, ok)).toMatch(/nonce/);
    expect(checkIdToken({ ...claims, exp: 1 }, ok)).toMatch(/expired/);
    expect(checkIdToken({ ...claims, iss: 'https://evil.test' }, ok)).toMatch(/issuer/);
  });
});

describe('the routes', () => {
  async function app(login: CloudUserLogin) {
    const f = Fastify();
    f.decorate('cloud', { cloudUser: login } as any);
    await f.register(cloudLoginRoutes, { prefix: '/api' });
    return f;
  }

  it('refuse plain HTTP from another machine', async () => {
    const { login } = await harness();
    const f = await app(login);
    const res = await f.inject({ method: 'POST', url: '/api/auth/cloud-login/begin', remoteAddress: '10.2.3.50' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('https_required');
  });

  it('allow plain HTTP on loopback, which never reaches a network', async () => {
    const { login } = await harness();
    const f = await app(login);
    const res = await f.inject({ method: 'POST', url: '/api/auth/cloud-login/begin', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ codeChallengeMethod: 'S256' });
  });

  it('complete the whole flow over HTTP', async () => {
    const { fake, login } = await harness();
    const f = await app(login);
    const begun = (await f.inject({ method: 'POST', url: '/api/auth/cloud-login/begin', remoteAddress: '127.0.0.1' })).json();
    const done = await f.inject({
      method: 'POST', url: '/api/auth/cloud-login/complete', remoteAddress: '127.0.0.1',
      payload: { requestId: begun.requestId, loginToken: mint(fake, begun) },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ signedIn: true, user: { sub: SUB }, replacedPrevious: false });

    const session = (await f.inject({ method: 'GET', url: '/api/auth/cloud-session', remoteAddress: '127.0.0.1' })).json();
    expect(session).toMatchObject({ configured: true, signedIn: true });

    const out = (await f.inject({ method: 'POST', url: '/api/auth/cloud-signout', remoteAddress: '127.0.0.1' })).json();
    expect(out).toEqual({ signedIn: false, revoked: true });
  });

  it('reject a malformed complete', async () => {
    const { login } = await harness();
    const f = await app(login);
    const res = await f.inject({
      method: 'POST', url: '/api/auth/cloud-login/complete', remoteAddress: '127.0.0.1', payload: { requestId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });
});
