// From the inventory and the live channel snapshot to a solver input.
//
// Pure: given the rows and the channels, say which transmitters can be
// coordinated, which cannot and why, and what each device needs before it
// can be. The route and the UI both consume this, so the reason a device is
// left out is the same sentence in both places.

import type { Channel } from '@rfdeck/shared-types';
import {
  familyOf, profileFor, profileFromLimits, candidateBands, bandCodes, bandIsReported,
  type BandProfile, type BandSource, type CoordinationFamily,
} from './profiles';
import type { CoordinationTransmitter } from './solver';

/** The inventory columns coordination reads. */
export interface RigDeviceRow {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  active: boolean;
  band: string | null;
  bandSource: string | null;
  dense: boolean;
  carrierMinKHz: number | null;
  carrierMaxKHz: number | null;
  carrierStepKHz: number | null;
}

export interface RigDevice {
  id: string;
  name: string;
  family: CoordinationFamily | null;
  /** Whether this family's receivers report their band over the protocol. */
  bandReported: boolean;
  band: string | null;
  bandSource: BandSource | null;
  dense: boolean;
  /** Bands whose range contains the device's current carrier(s), for the declare control. */
  candidates: string[];
  /** Every band code known for the family, for the same control. */
  codes: string[];
  /** Figures in the profile that were chosen rather than read. */
  assumed: BandProfile['assumed'];
  /** Can its channels go into a plan? If not, `reason` says what is missing. */
  ready: boolean;
  reason: string | null;
  channelCount: number;
}

export interface Rig {
  transmitters: CoordinationTransmitter[];
  devices: RigDevice[];
  /** Channels left out of the plan, each with the sentence that says why. */
  skipped: Array<{ id: string; name: string; deviceId: string; reason: string }>;
}

/** The inventory row a stable channel id belongs to: "<rowId>:<slot>". */
export function rowIdOfChannel(channelId: string): string | null {
  const i = channelId.lastIndexOf(':');
  return i > 0 ? channelId.slice(0, i) : null;
}

/** The band profile a row resolves to, or null with the reason it does not. */
export function profileForRow(row: RigDeviceRow): { profile: BandProfile | null; family: CoordinationFamily | null; reason: string | null } {
  const family = familyOf(row.manufacturer, row.model);
  if (!family) return { profile: null, family: null, reason: 'RFDeck cannot tune this model' };
  if (row.carrierMinKHz != null && row.carrierMaxKHz != null) {
    return {
      profile: profileFromLimits(family, row.carrierMinKHz, row.carrierMaxKHz, row.carrierStepKHz ?? undefined),
      family, reason: null,
    };
  }
  if (!row.band) {
    return {
      profile: null, family,
      reason: bandIsReported(family)
        ? 'the receiver has not reported its band yet'
        : 'its band has not been declared',
    };
  }
  const profile = profileFor(family, row.band);
  if (!profile) return { profile: null, family, reason: `band "${row.band}" is not in RFDeck's table for this family` };
  return { profile, family, reason: null };
}

export function buildRig(rows: RigDeviceRow[], channels: Channel[]): Rig {
  const byRow = new Map(rows.map(r => [r.id, r]));
  const channelsByRow = new Map<string, Channel[]>();
  for (const ch of channels) {
    const rowId = rowIdOfChannel(ch.id);
    if (!rowId) continue;
    const list = channelsByRow.get(rowId);
    if (list) list.push(ch); else channelsByRow.set(rowId, [ch]);
  }

  const transmitters: CoordinationTransmitter[] = [];
  const skipped: Rig['skipped'] = [];
  const devices: RigDevice[] = [];

  for (const row of rows) {
    if (!row.active) continue;
    const { profile, family, reason } = profileForRow(row);
    const chans = channelsByRow.get(row.id) ?? [];
    const carriers = chans.map(c => c.frequency).filter(f => f > 0);
    const candidates = family
      ? [...new Set(carriers.flatMap(f => candidateBands(family, f)))].sort()
      : [];

    devices.push({
      id: row.id, name: row.name, family,
      bandReported: family ? bandIsReported(family) : false,
      band: row.band,
      bandSource: row.bandSource === 'reported' || row.bandSource === 'declared' ? row.bandSource : null,
      dense: row.dense,
      candidates,
      codes: family ? bandCodes(family) : [],
      assumed: profile?.assumed ?? [],
      ready: !!profile,
      reason,
      channelCount: chans.length,
    });

    for (const ch of chans) {
      if (!profile) {
        skipped.push({ id: ch.id, name: ch.name, deviceId: row.id, reason: reason! });
        continue;
      }
      transmitters.push({
        id: ch.id, name: ch.name, profile,
        dense: row.dense,
        currentKHz: ch.frequency > 0 ? ch.frequency : undefined,
      });
    }
  }

  // Channels whose row is gone or inactive are not in the plan and are
  // said to be, rather than vanishing.
  for (const ch of channels) {
    const rowId = rowIdOfChannel(ch.id);
    if (rowId && byRow.has(rowId) && byRow.get(rowId)!.active) continue;
    const known = !!rowId && byRow.has(rowId);
    skipped.push({ id: ch.id, name: ch.name, deviceId: rowId ?? '', reason: known ? 'its device is inactive' : 'not an inventory device' });
  }

  return { transmitters, devices, skipped };
}
