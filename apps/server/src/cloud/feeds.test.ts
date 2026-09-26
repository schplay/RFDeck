import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FakeMeros } from './fakeMeros';
import { CloudClient } from './client';
import { CloudLink } from './link';
import { MemoryLinkStore } from './linkStore';
import { Feeds } from './feeds';
import { PackVerifyError } from './packSignature';
import { CloudConfig } from './config';

// The feed exists so a rig in a flight case still knows which TV channels are
// licensed where it is standing. So the tests are mostly about the offline path
// and about refusing to trust anything unverified — not about the happy fetch.

let fake: FakeMeros | null = null;
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-packs-'));
});

afterEach(async () => {
  await fake?.close();
  fake = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const cellPayload = {
  domain: 'US-FCC', channel_plan: 'US', cell: 'tn40w076', cell_deg: 2,
  stations: [{
    facility_id: 12477, call_sign: 'WTEST', rf_channel: 26, service: 'DT',
    lat: null, lon: null,
    contour: [[40, -75], [40, -74], [41, -74], [41, -75]],
  }],
};

async function harness(options: { linked?: boolean } = {}) {
  fake = new FakeMeros();
  const baseUrl = await fake.listen();
  const config: CloudConfig = {
    baseUrl, clientId: 'rfdeck-server-test',
    browserClientId: null, packKeys: fake.packKeys(),
  };
  const client = new CloudClient(config);
  const link = new CloudLink(config, client, new MemoryLinkStore());
  if (options.linked !== false) {
    await link.start();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && link.pendingLink?.outcome === 'pending') {
      await new Promise(r => setTimeout(r, 20));
    }
  }
  return { fake: fake!, config, feeds: new Feeds(config, client, link, dir) };
}

describe('fetching a pack', () => {
  it('verifies it, returns the payload, and caches it', async () => {
    const { fake, feeds } = await harness();
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload);

    const got = await feeds.fetch<typeof cellPayload>('regional-us-fcc-tn40w076');
    expect(got.fromCache).toBe(false);
    expect(got.payload.cell).toBe('tn40w076');
    expect(got.header.kid).toBe(fake.kid);
    expect(fs.existsSync(path.join(dir, 'regional-us-fcc-tn40w076.json'))).toBe(true);
  });

  it('re-polls conditionally, so an unchanged weekly poll is cheap', async () => {
    const { fake, feeds } = await harness();
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload);
    await feeds.fetch('regional-us-fcc-tn40w076');

    const got = await feeds.fetch<typeof cellPayload>('regional-us-fcc-tn40w076');
    // Served from cache off the back of a 304, not re-downloaded.
    expect(got.fromCache).toBe(true);
    expect(got.payload.cell).toBe('tn40w076');
    const conditional = fake.requests.filter(r => r.path.startsWith('/v1/feeds/'));
    expect(conditional).toHaveLength(2);
  });

  it('picks up a republished pack', async () => {
    const { fake, feeds } = await harness();
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload);
    const first = await feeds.fetch('regional-us-fcc-tn40w076');

    fake.publishPack('regional-us-fcc-tn40w076', { ...cellPayload, stations: [] });
    const second = await feeds.fetch<typeof cellPayload>('regional-us-fcc-tn40w076');
    expect(second.fromCache).toBe(false);
    expect(second.header.version).toBe(first.header.version + 1);
    expect(second.payload.stations).toHaveLength(0);
  });
});

describe('when the cloud is not there', () => {
  it('falls back to the cache, which is the whole point', async () => {
    const { fake, feeds } = await harness();
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload);
    await feeds.fetch('regional-us-fcc-tn40w076');
    await fake.close();                        // the venue has no uplink

    const got = await feeds.fetch<typeof cellPayload>('regional-us-fcc-tn40w076');
    expect(got.fromCache).toBe(true);
    expect(got.payload.stations[0].rf_channel).toBe(26);
  });

  it('answers from the cache with no network call at all', async () => {
    const { fake, feeds } = await harness();
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload);
    await feeds.fetch('regional-us-fcc-tn40w076');

    const got = feeds.cachedOnly<typeof cellPayload>('regional-us-fcc-tn40w076');
    expect(got?.payload.cell).toBe('tn40w076');
    expect(got?.fromCache).toBe(true);
  });

  it('reports nothing cached rather than inventing an empty pack', async () => {
    // An empty pack would read as "no TV stations here", which is a very
    // different claim from "I do not know".
    const { feeds } = await harness();
    expect(feeds.cachedOnly('regional-us-fcc-tn40w076')).toBeNull();
  });

  it('falls back to the cache when Meros refuses, too', async () => {
    const { fake, feeds } = await harness();
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload);
    await feeds.fetch('regional-us-fcc-tn40w076');

    // Entitlement lapses: the pack is now refused rather than unreachable.
    fake.packs.set('regional-us-fcc-tn40w076', {
      ...fake.packs.get('regional-us-fcc-tn40w076')!, entitled: true,
    });
    fake.revokeEverything();

    const got = await feeds.fetch<typeof cellPayload>('regional-us-fcc-tn40w076');
    expect(got.fromCache).toBe(true);
  });

  it('propagates a genuine absence rather than pretending', async () => {
    const { feeds } = await harness();
    await expect(feeds.fetch('regional-us-fcc-tn99e999')).rejects.toThrow();
  });
});

describe('nothing unverified becomes data', () => {
  it('refuses a pack signed by a key this build does not have', async () => {
    const { fake, config, feeds } = await harness();
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload);
    config.packKeys.clear();                   // as if the kid rotated

    await expect(feeds.fetch('regional-us-fcc-tn40w076')).rejects.toBeInstanceOf(PackVerifyError);
    // And nothing was cached, so the next read cannot pick it up either.
    expect(feeds.cachedOnly('regional-us-fcc-tn40w076')).toBeNull();
  });

  it('will not serve a cache file that has been edited on disk', async () => {
    // The cache is a file on a venue machine. "It verified when we wrote it" is
    // not the same as "it verifies now", so it is re-checked on the way out.
    const { fake, feeds } = await harness();
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload);
    await feeds.fetch('regional-us-fcc-tn40w076');

    const file = path.join(dir, 'regional-us-fcc-tn40w076.json');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [tag, header] = entry.response.signed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...cellPayload, stations: [] })).toString('base64url');
    entry.response.signed = `${tag}.${header}.${forged}`;
    fs.writeFileSync(file, JSON.stringify(entry));

    expect(feeds.cachedOnly('regional-us-fcc-tn40w076')).toBeNull();
    await fake.close();
    await expect(feeds.fetch('regional-us-fcc-tn40w076')).rejects.toThrow();
  });

  it('refuses a pack name that could climb out of the cache directory', async () => {
    const { feeds } = await harness();
    for (const bad of ['../escape', 'a/b', '..', './x', '']) {
      await expect(feeds.fetch(bad)).rejects.toThrowError(/not a usable pack name/);
    }
  });
});

describe('public packs', () => {
  it('are readable without a link at all', async () => {
    // The device-profile pack is public, so an unlinked rig should stay current on
    // band tables. Nothing here may require a token.
    const { fake, feeds } = await harness({ linked: false });
    fake.publishPack('device-profiles', { profiles: [] }, { entitled: false });

    const got = await feeds.fetch<{ profiles: unknown[] }>('device-profiles');
    expect(got.payload.profiles).toEqual([]);
    const call = fake.requests.find(r => r.path === '/v1/feeds/rfdeck/device-profiles')!;
    expect(call.auth).toBeNull();
  });

  it('but an entitled pack is refused when unlinked', async () => {
    const { fake, feeds } = await harness({ linked: false });
    fake.publishPack('regional-us-fcc-tn40w076', cellPayload, { entitled: true });
    await expect(feeds.fetch('regional-us-fcc-tn40w076')).rejects.toThrowError(/not_entitled/);
  });
});
