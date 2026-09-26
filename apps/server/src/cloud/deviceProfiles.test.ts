import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FakeMeros } from './fakeMeros';
import { CloudClient } from './client';
import { CloudLink } from './link';
import { MemoryLinkStore } from './linkStore';
import { Feeds } from './feeds';
import { DeviceProfiles, DEVICE_PROFILE_PACK } from './deviceProfiles';
import { CloudConfig } from './config';

// These numbers end up under transmitters. A signature proves a pack came from
// Meros; it does not prove the figures in it are sane — so everything here is
// about refusing a plausible-looking plan built on nonsense.

let fake: FakeMeros | null = null;
let dir = '';

const FAMILIES = new Set(['shure-ulxd', 'senn-ewdx']);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-profiles-')); });
afterEach(async () => {
  await fake?.close(); fake = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

let harnessCount = 0;

async function harness() {
  await fake?.close();
  fake = new FakeMeros();
  const baseUrl = await fake.listen();
  const config: CloudConfig = {
    baseUrl, clientId: 'c', browserClientId: null, packKeys: fake.packKeys(),
  };
  const client = new CloudClient(config);
  const link = new CloudLink(config, client, new MemoryLinkStore());
  // Its own cache directory per harness. Sharing one across harnesses is a real
  // trap: each fake generates a fresh signing key, but an identical pack version
  // produces an identical ETag — so a 304 would hand back a pack signed by the
  // previous harness's key and correctly fail to verify. Which is the right
  // behaviour, and a confusing way for a test to fail.
  const own = path.join(dir, `h${++harnessCount}`);
  const feeds = new Feeds(config, client, link, own);
  return { fake: fake!, profiles: new DeviceProfiles(feeds, FAMILIES) };
}

describe('the device-profile pack', () => {
  it('is readable with no link at all', async () => {
    // Public by design: an unlinked rig should still be current on band tables.
    // This is the one cloud feature that helps someone who never signs in.
    const { fake, profiles } = await harness();
    fake.publishPack(DEVICE_PROFILE_PACK, {
      generated_at: '2026-09-26T00:00:00Z',
      overrides: [{ family: 'shure-ulxd', stepKHz: 25, spacingKHz: { standard: 300, dense: 125 }, assumed: [] }],
    }, { entitled: false });

    const applied = await profiles.refresh();
    expect(applied.overrides.get('shure-ulxd')).toMatchObject({ stepKHz: 25 });
    expect(applied.generatedAt).toBe('2026-09-26T00:00:00Z');
    const call = fake.requests.find(r => r.path.endsWith(DEVICE_PROFILE_PACK))!;
    expect(call.auth).toBeNull();
  });

  it('leaves the shipped tables standing when there is no pack', async () => {
    // The normal state until Meros publishes one, and it must not be an error.
    const { profiles } = await harness();
    const applied = await profiles.refresh();
    expect(applied.overrides.size).toBe(0);
    expect(applied.rejected).toEqual([]);
  });

  it('keeps working from cache when the cloud is gone', async () => {
    const { fake, profiles } = await harness();
    fake.publishPack(DEVICE_PROFILE_PACK, { overrides: [{ family: 'senn-ewdx', stepKHz: 25 }] });
    await profiles.refresh();
    await fake.close();

    const applied = await profiles.refresh();
    expect(applied.overrides.get('senn-ewdx')).toMatchObject({ stepKHz: 25 });
  });

  it('loads from cache with no network call', async () => {
    const { fake, profiles } = await harness();
    fake.publishPack(DEVICE_PROFILE_PACK, { overrides: [{ family: 'senn-ewdx', stepKHz: 25 }] });
    await profiles.refresh();
    expect(profiles.loadCached().overrides.size).toBe(1);
  });
});

describe('refusing nonsense that a signature does not catch', () => {
  const applyOverride = async (override: unknown) => {
    const { fake, profiles } = await harness();
    fake.publishPack(DEVICE_PROFILE_PACK, { overrides: [override] });
    return profiles.refresh();
  };

  it('refuses a family this build cannot coordinate for', async () => {
    // A newer pack than the build, which is not an error in the pack — but the
    // rules are not there, so it cannot be applied.
    const applied = await applyOverride({ family: 'acme-future', stepKHz: 25 });
    expect(applied.overrides.size).toBe(0);
    expect(applied.rejected[0]).toMatchObject({ family: 'acme-future' });
    expect(applied.rejected[0].reason).toMatch(/no coordination rules/);
  });

  it('refuses an implausible tuning step', async () => {
    for (const stepKHz of [0, -25, 50_000, Number.NaN, 'wide' as any]) {
      const applied = await applyOverride({ family: 'shure-ulxd', stepKHz });
      expect(applied.overrides.size).toBe(0);
      expect(applied.rejected[0].reason).toMatch(/implausible tuning step/);
    }
  });

  it('refuses an implausible spacing', async () => {
    const applied = await applyOverride({ family: 'shure-ulxd', spacingKHz: { standard: -1 } });
    expect(applied.overrides.size).toBe(0);
    expect(applied.rejected[0].reason).toMatch(/implausible standard spacing/);
  });

  it('refuses dense spacing wider than standard', async () => {
    // Dense is the tighter one by definition. The other way round would widen a
    // High Density plan while claiming to tighten it.
    const applied = await applyOverride({
      family: 'shure-ulxd', spacingKHz: { standard: 125, dense: 350 },
    });
    expect(applied.overrides.size).toBe(0);
    expect(applied.rejected[0].reason).toMatch(/dense spacing is wider/);
  });

  it('refuses an override that names no family', async () => {
    const applied = await applyOverride({ stepKHz: 25 });
    expect(applied.overrides.size).toBe(0);
    expect(applied.rejected[0].reason).toMatch(/no family named/);
  });

  it('applies the good ones and refuses the bad, rather than all or nothing', async () => {
    const { fake, profiles } = await harness();
    fake.publishPack(DEVICE_PROFILE_PACK, {
      overrides: [
        { family: 'shure-ulxd', stepKHz: 25, assumed: [] },
        { family: 'shure-ulxd-typo', stepKHz: 25 },
        { family: 'senn-ewdx', stepKHz: 0 },
      ],
    });
    const applied = await profiles.refresh();
    expect([...applied.overrides.keys()]).toEqual(['shure-ulxd']);
    expect(applied.rejected).toHaveLength(2);
  });

  it('keeps only the assumption flags it understands', async () => {
    const applied = await applyOverride({
      family: 'senn-ewdx', stepKHz: 600, assumed: ['step', 'nonsense', 'spacing'],
    });
    expect(applied.overrides.get('senn-ewdx')?.assumed).toEqual(['step', 'spacing']);
  });

  it('carries the source, so an operator can judge a corrected figure', async () => {
    const applied = await applyOverride({
      family: 'senn-ewdx', stepKHz: 25, source: 'EW-DX user guide rev 3, p.41',
    });
    expect(applied.overrides.get('senn-ewdx')?.source).toMatch(/user guide/);
  });
});

describe('the family list cannot drift from the rules', () => {
  it('names exactly the families the coordinator has rules for', async () => {
    // COORDINATION_FAMILIES gates which overrides may apply. If a family gains
    // rules but is not listed here, a perfectly valid pack override is silently
    // refused — and "silently refused" is the failure mode this whole file exists
    // to avoid. So the two are asserted to agree rather than kept in step by hand.
    const { COORDINATION_FAMILIES, familyRuleKeys } =
      await import('../hardware/coordination/profiles');
    expect([...COORDINATION_FAMILIES].sort()).toEqual([...familyRuleKeys()].sort());
  });
});
