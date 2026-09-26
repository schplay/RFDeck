import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  toCloudDevice, MAX_DEVICES_PER_PUSH, InventorySync, InventoryScopeMissing,
} from './inventorySync';
import { FakeMeros } from './fakeMeros';
import { CloudClient } from './client';
import { CloudLink } from './link';
import { MemoryLinkStore } from './linkStore';
import { CloudConfig } from './config';

// The mapping onto Meros's shape. Mostly a rename, but three things are worth
// holding still: the enums Meros validates, the fields it must never see, and the
// integer coercion that would otherwise send NaN.

const row = () => ({
  id: 'dev-1',
  name: 'Rack 2 SR',
  manufacturer: 'Sennheiser',
  model: 'EW-DX EM 2',
  deviceType: 'input',
  serial: 'S1', mac: 'AA:BB:CC', firmware: '2.1.0',
  band: 'G50', bandSource: 'reported',
  carrierMinKHz: 470000, carrierMaxKHz: 608000, carrierStepKHz: 25,
  dense: true,
  location: 'SR wing', notes: 'spare',
  active: true, disabledSlots: '3,4',
  ip: '10.0.1.20', port: 443,
  addedAt: new Date('2026-09-20T10:00:00Z'),
  password: 'rack-two-access',
});

describe('the mapping onto Meros field names', () => {
  it('renames the camelCase fields Meros spells with underscores', () => {
    const d = toCloudDevice(row());
    expect(d.device_type).toBe('input');
    expect(d.band_source).toBe('reported');
    expect(d.carrier_min_khz).toBe(470000);
    expect(d.carrier_max_khz).toBe(608000);
    expect(d.carrier_step_khz).toBe(25);
    expect(d.disabled_slots).toBe('3,4');
    expect(d.device_added_at).toBe('2026-09-20T10:00:00.000Z');
    // Everything else is 1:1, and `id` stays `id` because it is the upsert key.
    expect(d.id).toBe('dev-1');
    expect(d.serial).toBe('S1');
  });

  it('never sends the password, because a listing has no use for it', () => {
    const json = JSON.stringify(toCloudDevice(row()));
    expect(json).not.toContain('rack-two-access');
    expect(json).not.toContain('password');
  });

  it('drops a value outside the enums Meros validates, rather than failing the push', () => {
    // A 422 names one bad field and refuses the whole batch, so one surprising row
    // must not cost two hundred good ones.
    const odd = toCloudDevice({ ...row(), deviceType: 'transmitter', bandSource: 'guessed' });
    expect(odd.device_type).toBeNull();
    expect(odd.band_source).toBeNull();
  });

  it('coerces the integer fields and drops what is not a number', () => {
    const d = toCloudDevice({
      ...row(), carrierMinKHz: null, carrierStepKHz: Number.NaN, port: 8080,
    });
    expect(d.carrier_min_khz).toBeNull();
    expect(d.carrier_step_khz).toBeNull();
    expect(d.port).toBe(8080);
  });

  it('treats a missing active flag as active, matching the local default', () => {
    expect(toCloudDevice({ id: 'x' }).active).toBe(true);
    expect(toCloudDevice({ id: 'x', active: false }).active).toBe(false);
  });

  it('sends an absent optional field as null rather than omitting it', () => {
    // Meros ignores unknown fields and accepts nulls; explicit nulls are what make a
    // reconcile clear a value that used to be set.
    const d = toCloudDevice({ id: 'bare' });
    expect(d.serial).toBeNull();
    expect(d.location).toBeNull();
    expect(d.device_added_at).toBeNull();
  });

  it('accepts a date that has already been serialised', () => {
    const d = toCloudDevice({ id: 'x', addedAt: '2026-01-02T03:04:05.000Z' });
    expect(d.device_added_at).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('the push cap', () => {
  it('is Meros\'s documented default', () => {
    expect(MAX_DEVICES_PER_PUSH).toBe(5000);
  });
});

// ── Against the fake ────────────────────────────────────────────────────────

let fake: FakeMeros | null = null;
afterEach(async () => { await fake?.close(); fake = null; vi.restoreAllMocks(); });

async function harness(options = {}) {
  fake = new FakeMeros(options);
  const baseUrl = await fake.listen();
  const config: CloudConfig = {
    baseUrl, clientId: 'rfdeck-server-test',
    browserClientId: null, packKeys: fake.packKeys(),
  };
  const client = new CloudClient(config);
  const link = new CloudLink(config, client, new MemoryLinkStore());
  await link.start();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && link.pendingLink?.outcome === 'pending') {
    await new Promise(r => setTimeout(r, 20));
  }
  const sync = new InventorySync(client, link);
  // The database is not what is under test here, so the rows are supplied directly.
  const withDevices = (rows: any[]) => {
    vi.spyOn(sync, 'build').mockResolvedValue(rows.map(toCloudDevice));
    return sync;
  };
  return { fake: fake!, sync, withDevices };
}

describe('publishing to the account', () => {
  it('sends the whole set and reports what the cloud stored', async () => {
    const { fake, withDevices } = await harness();
    const sync = withDevices([{ id: 'a', name: 'Rack 1' }, { id: 'b', name: 'Rack 2' }]);

    const result = await sync.push();
    expect(result.count).toBe(2);
    expect(result.updatedAt).toBeTruthy();
    expect(fake.inventory.map((d: any) => d.id)).toEqual(['a', 'b']);
  });

  it('is a reconcile: a device removed locally disappears from the listing', async () => {
    // The property with teeth. A client that assumed this merged would leave
    // devices listed forever; one that assumed it replaced when it merged would
    // show duplicates. Worth a test rather than a comment.
    const { fake, sync } = await harness();
    vi.spyOn(sync, 'build').mockResolvedValue([
      toCloudDevice({ id: 'a' }), toCloudDevice({ id: 'b' }),
    ]);
    await sync.push();

    vi.spyOn(sync, 'build').mockResolvedValue([toCloudDevice({ id: 'a' })]);
    await sync.push();

    expect(fake.inventory.map((d: any) => d.id)).toEqual(['a']);
  });

  it('reads back what it published', async () => {
    const { withDevices } = await harness();
    const sync = withDevices([{ id: 'a', name: 'Rack 1', serial: 'S1' }]);
    await sync.push();

    const listing = await sync.fetch();
    expect(listing.count).toBe(1);
    expect(listing.devices[0]).toMatchObject({ id: 'a', name: 'Rack 1', serial: 'S1' });
  });

  it('clears the listing without touching anything local', async () => {
    const { fake, withDevices } = await harness();
    const sync = withDevices([{ id: 'a' }]);
    await sync.push();
    await sync.clear();
    expect(fake.inventory).toEqual([]);
  });

  it('refuses locally rather than sending a batch over the cap', async () => {
    const { fake, sync } = await harness();
    vi.spyOn(sync, 'build').mockResolvedValue(
      Array.from({ length: MAX_DEVICES_PER_PUSH + 1 }, (_, i) => toCloudDevice({ id: `d${i}` })),
    );
    await expect(sync.push()).rejects.toThrow(/over the 5000/);
    // Caught before the request, so the message can say what it is rather than
    // relaying a 413.
    expect(fake.requests.some(r => r.path === '/v1/inventory/rfdeck')).toBe(false);
  });
});

describe('telling the two 403s apart', () => {
  it('reads insufficient_scope as "re-link", not "pay"', async () => {
    // An install linked before these scopes existed holds a token without them.
    // Sending that operator to a billing page would waste their time entirely.
    const { withDevices } = await harness({ withholdInventoryScope: true });
    const sync = withDevices([{ id: 'a' }]);
    await expect(sync.push()).rejects.toThrow(InventoryScopeMissing);
    await expect(sync.push()).rejects.toThrow(/link again/i);
  });
});
