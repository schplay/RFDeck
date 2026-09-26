/**
 * Which TV channels are licensed where the rig is standing.
 *
 * Meros publishes the FCC's own station contours as signed packs, sharded on a
 * fixed 2° grid. RFDeck does the geography itself: fetch the cell containing the
 * venue and the eight around it, then run a point-in-polygon test against each
 * station's service contour. The matching stations' RF channels are occupied, and
 * those become an exclusion source for the coordinator alongside scans.
 *
 * All of it local and offline — the pack is cached, the test runs here, and the
 * venue's coordinates never leave the building.
 *
 * Nothing in this file talks to a network. It is pure arithmetic over data
 * someone else fetched, which is why it can be tested properly.
 */

/** The grid Meros shards on. */
export const CELL_DEG = 2;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface TvStation {
  facility_id?: number;
  call_sign?: string;
  rf_channel: number;
  service?: string;
  /** Null for FCC data: the contour drives occupancy, not the transmitter point. */
  lat?: number | null;
  lon?: number | null;
  /** Service-area polygon as [lat, lon] pairs. */
  contour: [number, number][];
}

export interface TvCell {
  domain: string;
  channel_plan: string;
  cell: string;
  cell_deg?: number;
  stations: TvStation[];
}

// ── Cell ids ────────────────────────────────────────────────────────────────

/**
 * The id of the cell containing a point: its south-west corner, encoded
 * `t{n|s}{lat:02}{e|w}{lon:03}`.
 *
 * **`Math.floor`, never truncation.** For a western longitude the two disagree:
 * `Math.trunc(-76.3 / 2) * 2` is −76 but `Math.floor(-76.3 / 2) * 2` is −78, and
 * −78 is the correct south-west corner of the cell spanning [−78, −76).
 * Truncating does not throw or look wrong — it returns a real, adjacent,
 * plausible cell full of real stations, the wrong ones, for the entire western
 * hemisphere. Which is all of `US-FCC`.
 */
export function cellIdFor(point: LatLon): string {
  const latSw = Math.floor(point.lat / CELL_DEG) * CELL_DEG;
  const lonSw = Math.floor(point.lon / CELL_DEG) * CELL_DEG;
  return encodeCellId(latSw, lonSw);
}

/** Encode a south-west corner, given in signed degrees. */
export function encodeCellId(latSw: number, lonSw: number): string {
  const ns = latSw < 0 ? 's' : 'n';
  const ew = lonSw < 0 ? 'w' : 'e';
  const lat = String(Math.abs(latSw)).padStart(2, '0');
  const lon = String(Math.abs(lonSw)).padStart(3, '0');
  return `t${ns}${lat}${ew}${lon}`;
}

/** The south-west corner a cell id names, in signed degrees. */
export function decodeCellId(cell: string): LatLon {
  const m = /^t([ns])(\d{2})([ew])(\d{3})$/.exec(cell);
  if (!m) throw new Error(`"${cell}" is not a cell id`);
  const lat = Number(m[2]) * (m[1] === 's' ? -1 : 1);
  const lon = Number(m[4]) * (m[3] === 'w' ? -1 : 1);
  return { lat, lon };
}

/**
 * The cell containing a point and the eight around it.
 *
 * A 6°×6° window, which far exceeds any TV contour's reach — so no station whose
 * contour could cover the venue is missed. Meros also files a station in every
 * cell its contour overlaps, so the edge-spanning case is covered from the other
 * side too.
 *
 * Neighbours are derived in **signed degrees and encoded afterwards**, never by
 * manipulating the id string. The hemisphere letter flips at zero: a venue at
 * longitude −0.5 sits in `w002` and its eastern neighbour is `e000`. `US-FCC`
 * crosses neither zero, so a string-munging shortcut would work here and break on
 * `UK-OFCOM`, which straddles the prime meridian and is named as the next domain.
 */
export function cellsAround(point: LatLon): string[] {
  const latSw = Math.floor(point.lat / CELL_DEG) * CELL_DEG;
  const lonSw = Math.floor(point.lon / CELL_DEG) * CELL_DEG;
  const cells: string[] = [];
  for (let dLat = -CELL_DEG; dLat <= CELL_DEG; dLat += CELL_DEG) {
    for (let dLon = -CELL_DEG; dLon <= CELL_DEG; dLon += CELL_DEG) {
      const lat = latSw + dLat;
      const lon = lonSw + dLon;
      // Off the ends of the world is not a cell. Longitude wraps; latitude does
      // not, and a cell north of 90 or south of 90 simply does not exist.
      if (lat < -90 || lat > 88) continue;
      const wrapped = lon < -180 ? lon + 360 : lon >= 180 ? lon - 360 : lon;
      cells.push(encodeCellId(lat, wrapped));
    }
  }
  // Deduplicated because wrapping can bring two offsets to the same cell on a
  // narrow grid, and the centre cell should be fetched first.
  const centre = encodeCellId(latSw, lonSw);
  return [centre, ...cells.filter(c => c !== centre).filter((c, i, a) => a.indexOf(c) === i)];
}

// ── Point in polygon ────────────────────────────────────────────────────────

/**
 * Is a point inside a polygon? Ray casting, counting crossings.
 *
 * Contours are given as [lat, lon] pairs, which is the opposite of the (x, y)
 * order the algorithm is usually written in — so lon is x and lat is y here, and
 * the swap is done once, on the way in, rather than being remembered at each use.
 *
 * A point exactly on an edge is deliberately *inside*: a venue on the contour line
 * is within the protected area as far as the regulator is concerned, and a
 * coordination plan should keep off that channel.
 */
export function pointInPolygon(point: LatLon, contour: [number, number][]): boolean {
  if (!Array.isArray(contour) || contour.length < 3) return false;
  const x = point.lon;
  const y = point.lat;
  let inside = false;

  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const yi = contour[i][0], xi = contour[i][1];
    const yj = contour[j][0], xj = contour[j][1];
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      continue;
    }

    // On this edge? Then inside, and no need to count further.
    if (onSegment(x, y, xi, yi, xj, yj)) return true;

    const crosses = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function onSegment(x: number, y: number, xi: number, yi: number, xj: number, yj: number): boolean {
  const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
  if (Math.abs(cross) > 1e-12) return false;
  return x >= Math.min(xi, xj) - 1e-12 && x <= Math.max(xi, xj) + 1e-12
      && y >= Math.min(yi, yj) - 1e-12 && y <= Math.max(yi, yj) + 1e-12;
}

// ── Occupancy ───────────────────────────────────────────────────────────────

export interface OccupiedChannel {
  rfChannel: number;
  /** Every station protecting this channel here, for explaining the exclusion. */
  stations: { callSign: string | null; facilityId: number | null; service: string | null }[];
}

/**
 * Which RF channels are occupied at a point, across the cells we hold.
 *
 * Stations are unioned across cells first, then deduplicated by facility id —
 * Meros files a station in every cell its contour overlaps, so a station near a
 * cell boundary legitimately appears more than once in a nine-cell window.
 */
export function occupiedChannelsAt(point: LatLon, cells: TvCell[]): OccupiedChannel[] {
  const byChannel = new Map<number, OccupiedChannel>();
  const counted = new Set<string>();

  for (const cell of cells) {
    for (const station of cell.stations ?? []) {
      const channel = Math.round(Number(station.rf_channel));
      if (!Number.isFinite(channel) || channel <= 0) continue;

      // Identity for dedupe: facility id where there is one, otherwise the call
      // sign and channel, otherwise nothing and we accept a possible duplicate
      // rather than dropping a real station.
      const identity = station.facility_id != null
        ? `f${station.facility_id}`
        : station.call_sign
          ? `c${station.call_sign}|${channel}`
          : null;
      if (identity && counted.has(identity)) continue;

      if (!pointInPolygon(point, station.contour)) continue;
      if (identity) counted.add(identity);

      const entry = byChannel.get(channel) ?? { rfChannel: channel, stations: [] };
      entry.stations.push({
        callSign: station.call_sign ?? null,
        facilityId: station.facility_id ?? null,
        service: station.service ?? null,
      });
      byChannel.set(channel, entry);
    }
  }

  return [...byChannel.values()].sort((a, b) => a.rfChannel - b.rfChannel);
}

// ── Channel plans ───────────────────────────────────────────────────────────

/**
 * The frequency span of a TV channel, in kHz, for a named channel plan.
 *
 * kHz because that is what the solver's exclusions are in, and mixing units in a
 * coordination path is how a plan ends up a thousand times wrong.
 *
 * `US` is the only plan implemented, because `US-FCC` is the only pack Meros
 * publishes. `UK-OFCOM` is named as next; an unknown plan returns null rather than
 * guessing, and the caller reports the channel as unmappable instead of excluding
 * the wrong six megahertz.
 */
export function channelSpanKHz(plan: string, channel: number): [number, number] | null {
  if (plan.toUpperCase() !== 'US') return null;
  const ch = Math.round(channel);
  // Every US TV channel is 6 MHz wide; the bands are not contiguous, so the low
  // edge is looked up per band rather than computed from channel 2 throughout.
  let lowMHz: number | null = null;
  if (ch >= 2 && ch <= 4) lowMHz = 54 + (ch - 2) * 6;        // VHF low, 54–72
  else if (ch >= 5 && ch <= 6) lowMHz = 76 + (ch - 5) * 6;   // 76–88
  else if (ch >= 7 && ch <= 13) lowMHz = 174 + (ch - 7) * 6; // VHF high, 174–216
  else if (ch >= 14 && ch <= 51) lowMHz = 470 + (ch - 14) * 6; // UHF, 470–698
  if (lowMHz === null) return null;
  return [lowMHz * 1000, (lowMHz + 6) * 1000];
}

export interface TvExclusion {
  rfChannel: number;
  rangeKHz: [number, number];
  /** For explaining the exclusion to an operator rather than just applying it. */
  stations: OccupiedChannel['stations'];
}

/**
 * Turn occupancy into what the solver consumes, plus enough to explain it.
 *
 * Returns the exclusions and, separately, any channel that could not be mapped to
 * a frequency span. The unmapped list is deliberately not silent: quietly dropping
 * a licensed channel because the plan was unrecognised would produce a plan that
 * looks clean and is not, which is the one outcome worth refusing to hide.
 */
export function tvExclusions(
  point: LatLon,
  cells: TvCell[],
  plan?: string,
): { exclusions: TvExclusion[]; unmapped: number[]; plan: string } {
  const resolved = plan ?? cells.find(c => c.channel_plan)?.channel_plan ?? 'US';
  const occupied = occupiedChannelsAt(point, cells);
  const exclusions: TvExclusion[] = [];
  const unmapped: number[] = [];

  for (const entry of occupied) {
    const range = channelSpanKHz(resolved, entry.rfChannel);
    if (!range) {
      unmapped.push(entry.rfChannel);
      continue;
    }
    exclusions.push({ rfChannel: entry.rfChannel, rangeKHz: range, stations: entry.stations });
  }
  return { exclusions, unmapped, plan: resolved };
}

/** Just the pairs, in the shape `solve()` takes. */
export function exclusionRangesKHz(exclusions: TvExclusion[]): Array<[number, number]> {
  return exclusions.map(e => e.rangeKHz);
}
