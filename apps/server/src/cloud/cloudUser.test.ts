import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Fastify from 'fastify';
import { FakeMeros } from './fakeMeros';
import { CloudConfig } from './config';
import { CloudUserLogin } from './cloudUser';
import { MemoryCloudUserStore } from './cloudUserStore';
import { MerosClient, resolveMerosClientBinary } from './merosClient';
import { cloudLoginRoutes } from '../routes/cloudLogin';

// Signing a Meros cloud user in on this install, from a console, through the
// meros-client helper against RFDeck's fake Meros. The redeem itself (PKCE,
// the id_token checks, single use) is the helper's and tested there; these are
// for what RFDeck adds: refusing when unconfigured, recording who signed in and
// replacing them, and the routes the console calls.
//
// The test plays the console: it calls `begin`, mints the login token at the fake
// with the challenge and nonce it was given, and calls `complete`.

const CLOUD_USER_CLIENT = 'rfdeck-cloud-user-test';
const SUB = '0b9a3f6e-6a6b-4d5e-9a3f-1f2e3d4c5b6a';
const OTHER_SUB = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

let fake: FakeMeros | null = null;
let dir = '';
afterEach(async () => {
  await fake?.close();
  fake = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function harness(options: { cloudUserClientId?: string | null } = {}) {
  fake = new FakeMeros();
  const baseUrl = await fake.listen();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-clouduser-'));
  const config: CloudConfig = {
    baseUrl,
    clientId: 'rfdeck-server-test',
    browserClientId: null,
    cloudUserClientId: 'cloudUserClientId' in options ? options.cloudUserClientId : CLOUD_USER_CLIENT,
    packKeys: new Map(),
  };
  const meros = new MerosClient(config, resolveMerosClientBinary(), {
    stateDir: path.join(dir, 'meros'), keyFile: path.join(dir, 'meros.key'),
  });
  const store = new MemoryCloudUserStore();
  return { fake: fake!, store, login: new CloudUserLogin(config, meros, store) };
}

/** The console's half: mint a login token at Meros for what `begin` returned. */
function mint(f: FakeMeros, begun: { codeChallenge: string; nonce: string }, sub = SUB) {
  return f.mintLoginToken({
    codeChallenge: begun.codeChallenge, nonce: begun.nonce, clientId: CLOUD_USER_CLIENT,
    sub, name: 'Alex Example', email: `${sub.slice(0, 4)}@example.test`,
  });
}

describe('signing a cloud user in', () => {
  it('refuses when the Cloud User client is not configured, rather than half-working', async () => {
    const { login } = await harness({ cloudUserClientId: null });
    await expect(login.begin()).rejects.toMatchObject({ status: 503, code: 'not_configured' });
  });

  it('replaces a different cloud user who was signed in, and says so', async () => {
    const { fake, login } = await harness();
    const first = await login.begin();
    await login.complete(first.requestId, mint(fake, first));
    const second = await login.begin();
    const session = await login.complete(second.requestId, mint(fake, second, OTHER_SUB));
    expect(session).toMatchObject({ replacedPrevious: true, user: { sub: OTHER_SUB } });
    expect((await login.session()).user?.sub).toBe(OTHER_SUB);
  }, 30_000);

  it('refuses a login token minted for a different challenge', async () => {
    const { fake, login } = await harness();
    const begun = await login.begin();
    const other = await login.begin();
    await expect(login.complete(begun.requestId, mint(fake, other)))
      .rejects.toMatchObject({ status: 401, code: 'invalid_grant' });
    expect((await login.session()).signedIn).toBe(false);
  }, 30_000);
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
    expect(session).toMatchObject({ configured: true, signedIn: true, signedInVia: 'manifold' });

    const out = (await f.inject({ method: 'POST', url: '/api/auth/cloud-signout', remoteAddress: '127.0.0.1' })).json();
    expect(out).toEqual({ signedIn: false });
    // Signed out at Meros, not just here: revoked with the client named.
    expect(fake.unidentifiedRevocations).toBe(0);
    expect(fake.accessRevocations + fake.refreshRevocations).toBeGreaterThan(0);
  }, 30_000);

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
