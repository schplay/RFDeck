import { describe, it, expect, afterEach } from 'vitest';
import { FakeMeros } from './fakeMeros';
import { CloudClient, CloudRefused } from './client';
import { CloudLink } from './link';
import { MemoryLinkStore, MemoryEntitlementCache } from './linkStore';
import { Entitlements } from './entitlements';
import { CloudConfig } from './config';
import { verifySignedPack } from './packSignature';

// The instance link, against a fake Meros that behaves the way the real one
// does — including the parts that are unpleasant.

let fake: FakeMeros | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function harness(options = {}) {
  fake = new FakeMeros(options);
  const baseUrl = await fake.listen();
  const config: CloudConfig = {
    baseUrl,
    clientId: 'rfdeck-server-test',
    browserClientId: 'rfdeck-browser-test',
    packKeys: fake.packKeys(),
  };
  const client = new CloudClient(config);
  const store = new MemoryLinkStore();
  const link = new CloudLink(config, client, store);
  return { fake: fake!, config, client, store, link };
}

/** Wait for the background poller to reach a terminal outcome. */
async function settle(link: CloudLink, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const outcome = link.pendingLink?.outcome;
    if (outcome && outcome !== 'pending') return outcome;
    await new Promise(r => setTimeout(r, 20));
  }
  return link.pendingLink?.outcome ?? 'timeout';
}

describe('the instance link', () => {
  it('discovers endpoints rather than assuming them', async () => {
    const { client, fake } = await harness();
    expect(await client.deviceEndpoint()).toBe(`${fake.baseUrl}/oauth/device/code`);
    expect(await client.tokenEndpoint()).toBe(`${fake.baseUrl}/oauth/token`);
    // Cached: a second call must not re-fetch the well-known document.
    await client.tokenEndpoint();
    const discoveries = fake.requests.filter(r => r.path === '/.well-known/openid-configuration');
    expect(discoveries).toHaveLength(1);
  });

  it('requests only the scopes it actually uses', async () => {
    const { link, fake } = await harness();
    await link.start();
    const started = fake.requests.find(r => r.path === '/oauth/device/code')!;
    const scope = new URLSearchParams(started.body).get('scope')!.split(' ');
    expect(scope).toContain('offline_access');
    expect(scope).toContain('entitlements:read');
    expect(scope).toContain('backups:read');
    expect(scope).toContain('backups:write');
    // Events are emitted on this link; alerts are configured in the cloud over
    // them, so there is no alert scope to ask for. `alerts:send` belonged to a
    // relay endpoint Meros retracted.
    expect(scope).toContain('events:write');
    expect(scope).not.toContain('alerts:send');
    link.cancel();
  });

  it('links once the operator approves, and stores the refresh token', async () => {
    const { link, store } = await harness({ approveAfterPolls: 2 });
    const pending = await link.start();
    expect(pending.userCode).toBe('WXYZ-1234');
    expect(await settle(link)).toBe('linked');
    expect(await store.readRefreshToken()).toMatch(/^rt-/);
    expect(await link.isLinked()).toBe(true);
  });

  // RFC 8628 §3.5 says add five seconds, so settling genuinely takes ~7s here.
  // That is the correct behaviour, not slow test scaffolding — hence the timeout
  // rather than a smaller increment.
  it('backs off when told to slow down, instead of hammering', async () => {
    const { link } = await harness({ slowDownOnce: true, approveAfterPolls: 2 });
    const pending = await link.start();
    const before = pending.intervalMs;
    expect(await settle(link, 12_000)).toBe('linked');
    expect(pending.intervalMs).toBe(before + 5_000);
  }, 20_000);

  it('reports a refusal as declined, not as an error to retry', async () => {
    const { link } = await harness({ deny: true });
    await link.start();
    expect(await settle(link)).toBe('denied');
    expect(link.pendingLink?.detail).toMatch(/declined/i);
  });

  it('commits the rotated refresh token before handing back the access token', async () => {
    // The ordering that matters: if the access token were usable before the new
    // refresh token was durable, a crash in between would present a stale token
    // on the next start and kill the link.
    const { link, store } = await harness();
    await link.start();
    await settle(link);
    const first = await store.readRefreshToken();

    const token = await link.token();
    expect(token).toMatch(/^at-/);

    // Force a refresh and check the store moved on before the token came back.
    (link as any).accessToken = null;
    const refreshed = await link.token();
    expect(refreshed).toMatch(/^at-/);
    const second = await store.readRefreshToken();
    expect(second).not.toBe(first);
    // Every token handed back was written first, so the last write is current.
    expect(store.writes.at(-1)).toBe(second);
  });

  it('treats a replayed refresh token as an unlink, not a retry', async () => {
    // The breach path. Meros revokes the whole family; retrying cannot help, and
    // a background loop would hide the one thing the operator needs told.
    const { link, store, fake } = await harness();
    await link.start();
    await settle(link);
    const stolen = (await store.readRefreshToken())!;

    // Rotate once legitimately, then put the old token back as a crashed
    // process would have done.
    (link as any).accessToken = null;
    await link.token();
    await store.saveRefreshToken(stolen);
    (link as any).accessToken = null;

    await expect(link.token()).rejects.toThrowError(/established again/i);
    expect(fake.familyRevocations).toBe(1);
    expect(link.needsRelink).toMatch(/Settings/);
    // The dead token is cleared rather than left to be replayed again.
    expect(await store.readRefreshToken()).toBeNull();
  });

  it('stops asking once the link is dead', async () => {
    const { link, store, fake } = await harness();
    await link.start();
    await settle(link);
    const stolen = (await store.readRefreshToken())!;
    (link as any).accessToken = null;
    await link.token();
    await store.saveRefreshToken(stolen);
    (link as any).accessToken = null;
    await expect(link.token()).rejects.toThrow();

    const before = fake.requests.length;
    await expect(link.token()).rejects.toThrow();
    // No further network traffic: the answer is already known.
    expect(fake.requests.length).toBe(before);
  });

  it('shares one refresh between concurrent callers', async () => {
    // Two simultaneous refreshes would each present the same token, and the
    // second would look exactly like a replay.
    const { link, fake } = await harness();
    await link.start();
    await settle(link);
    (link as any).accessToken = null;

    const tokens = await Promise.all([link.token(), link.token(), link.token()]);
    expect(new Set(tokens).size).toBe(1);
    const refreshes = fake.requests.filter(r =>
      r.path === '/oauth/token' && new URLSearchParams(r.body).get('grant_type') === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(fake.familyRevocations).toBe(0);
  });

  it('unlinks locally even when Meros cannot be reached', async () => {
    const { link, store, fake } = await harness();
    await link.start();
    await settle(link);
    await fake.close();                     // the venue's uplink drops

    const { revoked } = await link.unlink();
    expect(revoked).toBe(false);
    // An operator who said "unlink" must not be left linked by a network fault.
    expect(await store.readRefreshToken()).toBeNull();
  });

  it('revokes at Meros when it can', async () => {
    const { link, fake } = await harness();
    await link.start();
    await settle(link);
    const { revoked } = await link.unlink();
    expect(revoked).toBe(true);
    expect(fake.requests.some(r => r.path === '/oauth/revoke')).toBe(true);
  });
});

describe('entitlements', () => {
  it('reads the account and its features, and learns its own account id', async () => {
    const { client, link } = await harness();
    await link.start();
    await settle(link);
    // No database in this test, so the cache write is skipped; the fetch is what
    // is under test.
    const ents = new Entitlements(client, link, new MemoryEntitlementCache());
    const snap = await ents.refresh().then(() => ents.snapshot());
    expect(snap.features).toContain('rfdeck.regional-data');
    expect(snap.features).toContain('rfdeck.notify-relay');
  });

  it('grants everything while gating is deferred, but reports what is held honestly', async () => {
    const { client, link } = await harness({ features: [] });
    await link.start();
    await settle(link);
    const ents = new Entitlements(client, link, new MemoryEntitlementCache());
    await ents.refresh();
    // The gate is built and open — the point of deferred gating.
    expect(await ents.entitled('rfdeck.regional-data')).toBe(true);
    // ...while the honest answer is still available to anyone who asks for it.
    expect(await ents.holds('rfdeck.regional-data')).toBe(false);
  });

  it('keeps answering from cache when Meros goes away', async () => {
    const { client, link, fake } = await harness();
    await link.start();
    await settle(link);
    const ents = new Entitlements(client, link, new MemoryEntitlementCache());
    await ents.refresh();
    await fake.close();

    await ents.refresh();                   // fails, quietly
    const snap = await ents.snapshot();
    expect(snap.features).toContain('rfdeck.regional-data');
    expect(snap.lastError).toBeTruthy();
  });
});

describe('the fake cloud signs packs the real verifier accepts', () => {
  it('round-trips a signed cell through verifySignedPack', async () => {
    const { fake, config } = await harness();
    const payload = { domain: 'US-FCC', channel_plan: 'US', cell: 'tn40w076', stations: [] };
    const response = fake.signPack('regional-us-fcc-tn40w076', payload);
    const { header, payload: verified } = verifySignedPack<typeof payload>(response, config.packKeys);
    expect(header.kid).toBe(fake.kid);
    expect(verified.cell).toBe('tn40w076');
  });

  it('rejects a pack whose payload was swapped after signing', async () => {
    const { fake, config } = await harness();
    const response = fake.signPack('regional-us-fcc-tn40w076', { cell: 'tn40w076' });
    const b64 = Buffer.from(JSON.stringify({ cell: 'tn00e000' })).toString('base64url');
    const [tag, header] = (response.signed as string).split('.');
    const tampered = { ...response, signed: `${tag}.${header}.${b64}` };
    expect(() => verifySignedPack(tampered, config.packKeys)).toThrowError(/does not verify/);
  });
});
