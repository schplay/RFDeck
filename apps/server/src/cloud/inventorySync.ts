import { prisma } from '../db';
import { log } from '../logger';
import { CloudClient, CloudRefused } from './client';
import { CloudLink } from './link';

/**
 * The online inventory listing: the operator's asset list, in their Meros account.
 *
 * A dedicated resource rather than a document, because it is not a file an operator
 * opens — it is a mirror of one table, kept current so they can look up what they own
 * from a phone without being at the rack.
 *
 * **RFDeck is the source of truth and the push is a reconcile.** `PUT` sends the full
 * set; the cloud upserts each device by `id` and drops anything absent. That is the
 * right direction for this data — the rig knows what hardware exists, the cloud does
 * not — and it means a deletion here propagates instead of leaving a device listed
 * forever because nothing ever said it was gone.
 *
 * There is deliberately no pull. A cloud listing that could overwrite the local
 * inventory would be a second, quieter path to the destruction that
 * `configBackup.restore()` makes an operator confirm. Restoring hardware is that
 * feature's job.
 */

/** Meros's per-push cap. Larger than any real rig, but it is their limit, not ours. */
export const MAX_DEVICES_PER_PUSH = 5000;

/** One device, in Meros's snake_case convention. */
export interface CloudInventoryDevice {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  device_type?: string | null;
  serial?: string | null;
  mac?: string | null;
  firmware?: string | null;
  band?: string | null;
  band_source?: string | null;
  carrier_min_khz?: number | null;
  carrier_max_khz?: number | null;
  carrier_step_khz?: number | null;
  dense?: boolean;
  location?: string | null;
  notes?: string | null;
  active?: boolean;
  disabled_slots?: string | null;
  ip?: string | null;
  port?: number | null;
  device_added_at?: string | null;
}

export interface CloudInventoryListing {
  product: string;
  count: number;
  updated_at: string | null;
  devices: CloudInventoryDevice[];
}

/**
 * The scopes this needs, which existing links do not have.
 *
 * `inventory:read` / `inventory:write` were added after installs were already linked,
 * and a token minted before then simply does not carry them. Meros answers
 * `403 insufficient_scope`, which is not a fault and not an entitlement problem — it
 * means re-link. Worth telling apart, because "your subscription does not include
 * this" would send an operator to the wrong place entirely.
 */
export class InventoryScopeMissing extends Error {
  constructor() {
    super(
      'This rig was linked before inventory sync existed, so its cloud access does not '
      + 'cover it yet. Unlink and link again in Settings → Cloud to enable it.',
    );
    this.name = 'InventoryScopeMissing';
  }
}

/**
 * A device row as Meros wants it.
 *
 * Every field is optional to Meros except `id`, and unknown fields are ignored — so
 * this can gain a column before Meros mirrors it without the push starting to fail.
 * The `password` column is absent, and not because it is filtered: a listing has no
 * use for it, so it is never read.
 */
export function toCloudDevice(row: {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  deviceType?: string | null;
  serial?: string | null;
  mac?: string | null;
  firmware?: string | null;
  band?: string | null;
  bandSource?: string | null;
  carrierMinKHz?: number | null;
  carrierMaxKHz?: number | null;
  carrierStepKHz?: number | null;
  dense?: boolean | null;
  location?: string | null;
  notes?: string | null;
  active?: boolean | null;
  disabledSlots?: string | null;
  ip?: string | null;
  port?: number | null;
  addedAt?: Date | string | null;
}): CloudInventoryDevice {
  // Meros constrains these to two values each. Sending anything else is a 422 that
  // names the field, so a row with a surprising value is dropped to null rather than
  // failing a push of two hundred good ones.
  const deviceType = row.deviceType === 'input' || row.deviceType === 'output'
    ? row.deviceType : null;
  const bandSource = row.bandSource === 'reported' || row.bandSource === 'manual'
    ? row.bandSource : null;

  const addedAt = row.addedAt instanceof Date
    ? row.addedAt.toISOString()
    : (typeof row.addedAt === 'string' ? row.addedAt : null);

  return {
    id: row.id,
    name: row.name ?? null,
    manufacturer: row.manufacturer ?? null,
    model: row.model ?? null,
    device_type: deviceType,
    serial: row.serial ?? null,
    mac: row.mac ?? null,
    firmware: row.firmware ?? null,
    band: row.band ?? null,
    band_source: bandSource,
    carrier_min_khz: int(row.carrierMinKHz),
    carrier_max_khz: int(row.carrierMaxKHz),
    carrier_step_khz: int(row.carrierStepKHz),
    dense: !!row.dense,
    location: row.location ?? null,
    notes: row.notes ?? null,
    active: row.active !== false,
    disabled_slots: row.disabledSlots ?? null,
    ip: row.ip ?? null,
    port: int(row.port),
    device_added_at: addedAt,
  };
}

/**
 * Meros wants integers; anything that is not one becomes null.
 *
 * The `null` check has to come first. `Number(null)` is `0`, so without it a device
 * with no known tuning range would be published as tuning down to 0 kHz — a real
 * value, and a wrong one, where the truth is "not known".
 */
function int(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : null;
}

export class InventorySync {
  constructor(
    private readonly client: CloudClient,
    private readonly link: CloudLink,
  ) {}

  private get url(): string {
    return `${this.client.baseUrl}/v1/inventory/rfdeck`;
  }

  /** Every device this install knows about, in Meros's shape. */
  async build(): Promise<CloudInventoryDevice[]> {
    const rows = await prisma.inventoryDevice.findMany({ orderBy: { id: 'asc' } });
    return rows.map(toCloudDevice);
  }

  /**
   * Replace the account's listing with this install's inventory.
   *
   * A reconcile, so a device removed here disappears there. That also means a second
   * rig pushing to the same account would overwrite the first — see the note in the
   * service about why this is a deliberate action rather than an automatic one.
   */
  async push(): Promise<{ count: number; updatedAt: string | null }> {
    const devices = await this.build();
    if (devices.length > MAX_DEVICES_PER_PUSH) {
      throw new Error(
        `This install has ${devices.length} devices, over the ${MAX_DEVICES_PER_PUSH} `
        + `the cloud accepts in one push.`,
      );
    }

    const token = await this.link.token();
    try {
      const result = await this.client.json<{ count?: number; updated_at?: string }>(
        'PUT', this.url, { token, body: { devices } },
      );
      log.info(`[Cloud] Pushed ${devices.length} device(s) to the online inventory`);
      return {
        count: Number(result?.count ?? devices.length),
        updatedAt: typeof result?.updated_at === 'string' ? result.updated_at : null,
      };
    } catch (err) {
      throw this.translate(err);
    }
  }

  /** What the cloud currently lists, so an operator can see the push landed. */
  async fetch(): Promise<CloudInventoryListing> {
    const token = await this.link.token();
    try {
      const raw = await this.client.json<any>('GET', this.url, { token });
      return {
        product: typeof raw?.product === 'string' ? raw.product : 'rfdeck',
        count: Number(raw?.count ?? (Array.isArray(raw?.devices) ? raw.devices.length : 0)),
        updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : null,
        devices: Array.isArray(raw?.devices) ? raw.devices : [],
      };
    } catch (err) {
      throw this.translate(err);
    }
  }

  /** Clear the listing. An empty reconcile, which is how Meros spells "remove it all". */
  async clear(): Promise<void> {
    const token = await this.link.token();
    try {
      await this.client.json('PUT', this.url, { token, body: { devices: [] } });
      log.info('[Cloud] Cleared the online inventory listing');
    } catch (err) {
      throw this.translate(err);
    }
  }

  /**
   * Turn Meros's refusals into something an operator can act on.
   *
   * `403` covers two different problems with different answers — a token minted
   * before these scopes existed, and an account without the subscription — and
   * sending someone to the billing page over a stale token would waste their time.
   */
  private translate(err: unknown): Error {
    if (err instanceof CloudRefused && err.status === 403) {
      // `code` is already Meros's `error` string, parsed by the client.
      if (err.code === 'insufficient_scope') return new InventoryScopeMissing();
      if (err.code === 'not_entitled') {
        return new Error('Your Meros account does not currently include the online inventory.');
      }
    }
    if (err instanceof CloudRefused && err.status === 413) {
      return new Error('The cloud refused the inventory as too large to store in one push.');
    }
    if (err instanceof CloudRefused && err.status === 422) {
      // Meros names `devices[i].field`, which is the only useful thing to relay.
      return new Error(`The cloud rejected a device in the inventory: ${err.message}`);
    }
    return err as Error;
  }
}
