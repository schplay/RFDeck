import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Fastify from 'fastify';

// Signing in with Meros, through the real meros-client helper in its fake mode
// (`issuer: "fake:"`): the instance link by loopback (RFDeck Desktop) and by
// redirect (a server), people signing in to sync preferences, and the routes
// the UI calls. The helper has its own tests for the protocol (PAR, PKCE, the
// id_token, iss and state checks); these are for RFDeck's side. The database
// is replaced so nothing here writes to a real one.

const db = vi.hoisted(() => ({
  settings: { id: 1, cloudLinkedAt: null as Date | null, eventToCloud: false },
  tokens: new Map<string, any>(),
}));
vi.mock('../db', () => ({
  prisma: {
    settings: {
      findFirst: async () => db.settings,
      create: async () => db.settings,
      update: async ({ data }: any) => Object.assign(db.settings, data),
    },
    personToken: {
      create: async ({ data }: any) => {
        const row = { createdAt: new Date(), lastUsedAt: new Date(), ...data };
        db.tokens.set(data.tokenHash, row);
        return row;
      },
      findUnique: async ({ where }: any) => db.tokens.get(where.tokenHash) ?? null,
      findMany: async ({ where }: any) => {
        const sessions = new Set<string>();
        for (const row of db.tokens.values()) {
          if (row.sub === where.sub && row.session !== where.NOT.session) sessions.add(row.session);
        }
        return [...sessions].map(session => ({ session }));
      },
      update: async ({ where, data }: any) => Object.assign(db.tokens.get(where.tokenHash), data),
      updateMany: async ({ where, data }: any) => {
        for (const row of db.tokens.values()) if (row.sub === where.sub) Object.assign(row, data);
      },
      delete: async ({ where }: any) => db.tokens.delete(where.tokenHash),
      deleteMany: async ({ where }: any) => {
        for (const [hash, row] of db.tokens) if (row.sub === where.sub) db.tokens.delete(hash);
      },
    },
  },
}));

import { CloudConfig } from './config';
import { MerosClient, resolveMerosClientBinary } from './merosClient';
import { CloudLink } from './link';
import { People } from './people';
import { SignIn, SignInError, safeReturnTo } from './signIn';
import { cloudRoutes } from '../routes/cloud';

const BIN = resolveMerosClientBinary();
const CALLBACK = 'https://rack.lan:8443/api/cloud/signin/callback';

let dir = '';
let meros: MerosClient;
let config: CloudConfig;

function setup(options: { desktop?: boolean; people?: boolean } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-signin-'));
  config = {
    baseUrl: 'fake:', clientId: 'rfdeck-server', cloudUserClientId: null,
    browserClientId: options.people === false ? null : 'rfdeck-browser', packKeys: new Map(),
  };
  meros = new MerosClient(config, BIN, { stateDir: path.join(dir, 'meros'), keyFile: path.join(dir, 'meros.key') });
  const link = new CloudLink(config, meros);
  const people = new People(config, meros);
  return { link, people, signIn: new SignIn(meros, link, people, options.desktop ?? false) };
}

/** meros.co's sign-in page, answered as the person would. */
async function authorize(authorizeUrl: string, deny = false): Promise<Record<string, string>> {
  const res = await meros.run<{ callback_url: string }>('fake.authorize', { authorize_url: authorizeUrl, deny });
  return Object.fromEntries(new URL(res.callback_url).searchParams);
}

beforeEach(() => {
  db.settings = { id: 1, cloudLinkedAt: null, eventToCloud: false };
  db.tokens.clear();
});

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('linking RFDeck Desktop', () => {
  it('links through the system browser, with no code', async () => {
    const { link, signIn } = setup({ desktop: true });
    expect(signIn.usesLoopback(true)).toBe(true);
    expect(await signIn.signInHere('instance', false)).toBeNull();
    expect(await link.isLinked()).toBe(true);
    expect(db.settings.cloudLinkedAt).toBeInstanceOf(Date);
  }, 30_000);

  it('is linked only from the computer it runs on', async () => {
    const { signIn } = setup({ desktop: true });
    expect(signIn.usesLoopback(false)).toBe(false);
    await expect(signIn.begin('instance', CALLBACK, '#/', false))
      .rejects.toMatchObject({ code: 'link_from_this_computer' });
  });
});

describe('linking a server from a browser', () => {
  it('pushes the request, then finishes in the browser that began it', async () => {
    const { link, signIn } = setup();
    expect(signIn.usesLoopback(true)).toBe(false);
    const begun = await signIn.begin('instance', CALLBACK, '#/settings/cloud', false);
    // Only the client and the pushed request travel through the browser.
    expect(new URL(begun.authorizeUrl).searchParams.get('client_id')).toBe('rfdeck-server');
    expect(new URL(begun.authorizeUrl).searchParams.get('request_uri')).toMatch(/^urn:ietf:params:oauth:request_uri:/);

    const back = await authorize(begun.authorizeUrl);
    const finished = await signIn.finish(back, begun.state);
    expect(finished).toEqual({ purpose: 'instance', returnTo: '#/settings/cloud' });
    expect(await link.isLinked()).toBe(true);
  }, 30_000);

  it('refuses a callback without this browser\'s state cookie', async () => {
    const { link, signIn } = setup();
    const begun = await signIn.begin('instance', CALLBACK, '#/', false);
    const back = await authorize(begun.authorizeUrl);
    await expect(signIn.finish(back, undefined)).rejects.toMatchObject({ code: 'state_mismatch' });
    await expect(signIn.finish(back, 'someone-else')).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(await link.isLinked()).toBe(false);
  }, 30_000);

  it('finishes each sign-in once', async () => {
    const { signIn } = setup();
    const begun = await signIn.begin('instance', CALLBACK, '#/', false);
    const back = await authorize(begun.authorizeUrl);
    await signIn.finish(back, begun.state);
    await expect(signIn.finish(back, begun.state)).rejects.toMatchObject({ code: 'unknown_request' });
  }, 30_000);

  it('says so when the person cancels at meros.co', async () => {
    const { link, signIn } = setup();
    const begun = await signIn.begin('instance', CALLBACK, '#/', false);
    const back = await authorize(begun.authorizeUrl, true);
    await expect(signIn.finish(back, begun.state)).rejects.toMatchObject({ code: 'access_denied' });
    expect(await link.isLinked()).toBe(false);
  }, 30_000);
});

describe('people signing in to sync preferences', () => {
  it('keeps the person apart from the instance link, even when they are the same person', async () => {
    // The fake signs everyone in as the same person, which is the case that
    // matters: the person who links a rig is usually the person who signs in to it.
    const { link, people, signIn } = setup({ desktop: true });
    await signIn.signInHere('instance', false);
    const signedIn = await signIn.signInHere('person', true);
    expect(signedIn?.person).toMatchObject({ sub: 'u1', name: 'Pat', persistent: true });
    expect(signedIn?.person.session).not.toBe('instance');

    // Signing the person out leaves the rig linked.
    await people.signOut(signedIn!.person);
    expect(await link.isLinked()).toBe(true);
    expect(await people.resolve(signedIn!.token)).toBeNull();
  }, 30_000);

  it('syncs preferences through the person\'s own session', async () => {
    const { people, signIn } = setup({ desktop: true });
    const signedIn = (await signIn.signInHere('person', false))!;
    const person = (await people.resolve(signedIn.token))!;
    await people.putProfile(person, { 'rfdeck-layout': { cards: 3 } });
    const profile = await people.profile(person);
    expect(profile.keys).toEqual({ 'rfdeck-layout': { cards: 3 } });
    expect(Object.keys(profile.key_meta)).toEqual(['rfdeck-layout']);
  }, 30_000);

  it('keeps one session per person when they sign in again', async () => {
    const { people, signIn } = setup({ desktop: true });
    const first = (await signIn.signInHere('person', false))!;
    const second = (await signIn.signInHere('person', false))!;
    // Both browsers now act through the newer session.
    expect((await people.resolve(first.token))?.session).toBe(second.person.session);
    const sessions = await meros.run<{ sessions: { session: string; signed_in: boolean }[] }>('signin.list');
    expect(sessions.sessions.filter(s => s.signed_in).map(s => s.session)).toEqual([second.person.session]);
  }, 30_000);

  it('hands a redirect sign-in to its browser once, by a code', async () => {
    const { people, signIn } = setup();
    const begun = await signIn.begin('person', CALLBACK, '#/', false);
    expect(new URL(begun.authorizeUrl).searchParams.get('client_id')).toBe('rfdeck-browser');
    const finished = await signIn.finish(await authorize(begun.authorizeUrl), begun.state);
    expect(finished.purpose).toBe('person');
    const claimed = await people.claim(finished.claim!);
    expect(claimed?.person.sub).toBe('u1');
    expect(await people.claim(finished.claim!)).toBeNull();
  }, 30_000);

  it('is unavailable without the RFDeck Browser client', async () => {
    const { signIn } = setup({ people: false });
    await expect(signIn.begin('person', CALLBACK, '#/', false)).rejects.toBeInstanceOf(SignInError);
  });
});

describe('the return address', () => {
  it('is only ever a route in the UI', () => {
    expect(safeReturnTo('#/settings/cloud')).toBe('#/settings/cloud');
    expect(safeReturnTo('https://evil.example')).toBe('#/');
    expect(safeReturnTo('//evil.example')).toBe('#/');
    expect(safeReturnTo(undefined)).toBe('#/');
  });
});

describe('the routes', () => {
  async function app(signIn: SignIn, people: People) {
    const f = Fastify();
    const afterLink = vi.fn(async () => {});
    f.decorate('cloud', { configured: true, signIn, people, afterLink } as any);
    await f.register(cloudRoutes, { prefix: '/api' });
    return { f, afterLink };
  }

  it('link a server: redirect out, cookie set, callback back to the page', async () => {
    const { link, people, signIn } = setup();
    const { f, afterLink } = await app(signIn, people);
    const begin = await f.inject({
      method: 'POST', url: '/api/cloud/signin', remoteAddress: '10.2.3.50',
      headers: { host: 'rack.lan:8443' },
      payload: { purpose: 'instance', returnTo: '#/settings/cloud' },
    });
    expect(begin.statusCode).toBe(200);
    const cookie = String(begin.headers['set-cookie']);
    expect(cookie).toMatch(/^rfdeck_signin=.+; Path=\/api\/cloud\/signin;.*HttpOnly; Secure; SameSite=Lax$/);

    const back = await authorize(begin.json().redirect);
    const callback = await f.inject({
      method: 'GET',
      url: `/api/cloud/signin/callback?${new URLSearchParams(back)}`,
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/?signin=linked#/settings/cloud');
    expect(afterLink).toHaveBeenCalled();
    expect(await link.isLinked()).toBe(true);
  }, 30_000);

  it('send a refused callback back to the page with the reason', async () => {
    const { people, signIn } = setup();
    const { f } = await app(signIn, people);
    const begin = await f.inject({
      method: 'POST', url: '/api/cloud/signin', remoteAddress: '10.2.3.50',
      headers: { host: 'rack.lan:8443' }, payload: { purpose: 'person', returnTo: '#/rf' },
    });
    const back = await authorize(begin.json().redirect);
    const callback = await f.inject({ method: 'GET', url: `/api/cloud/signin/callback?${new URLSearchParams(back)}` });
    expect(callback.headers.location).toBe('/?signin_error=state_mismatch&signin_for=person#/rf');
  }, 30_000);

  it('sign a person in on RFDeck Desktop, then sync and sign out with their token', async () => {
    const { people, signIn } = setup({ desktop: true });
    const { f } = await app(signIn, people);
    const done = await f.inject({
      method: 'POST', url: '/api/cloud/signin', remoteAddress: '127.0.0.1', payload: { purpose: 'person' },
    });
    expect(done.json()).toMatchObject({ signedIn: true, purpose: 'person', person: { sub: 'u1' } });
    const headers = { 'x-rfdeck-person': done.json().token };

    const put = await f.inject({ method: 'PUT', url: '/api/cloud/me/profile', headers, payload: { keys: { 'rfdeck-ui': 1 } } });
    expect(put.json().keys).toEqual({ 'rfdeck-ui': 1 });
    expect((await f.inject({ method: 'GET', url: '/api/cloud/me', headers })).json().person.sub).toBe('u1');

    expect((await f.inject({ method: 'POST', url: '/api/cloud/me/signout', headers })).json()).toEqual({ signedIn: false });
    expect((await f.inject({ method: 'GET', url: '/api/cloud/me/profile', headers })).statusCode).toBe(401);
  }, 30_000);

  it('refuse a profile call without a person', async () => {
    const { people, signIn } = setup();
    const { f } = await app(signIn, people);
    const res = await f.inject({ method: 'GET', url: '/api/cloud/me/profile' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('person_signed_out');
  });
});
