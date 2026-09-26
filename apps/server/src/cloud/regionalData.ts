import { log } from '../logger';
import { Feeds } from './feeds';
import {
  LatLon, TvCell, cellsAround, tvExclusions, exclusionRangesKHz, TvExclusion,
} from '../hardware/coordination/tvOccupancy';

/**
 * Regional TV occupancy, from the signed feed to the coordinator's exclusions.
 *
 * Meros publishes station contours sharded on a 2° grid; RFDeck fetches the
 * venue's cell and the eight around it, then runs the point-in-polygon test
 * locally. So the answer is available with no network, and the venue's
 * coordinates never leave the building.
 *
 * The index is fetched to learn which cells exist, because most of a nine-cell
 * window over a coastal or border venue is ocean or another country — asking for
 * cells that were never published would be nine 404s a week for nothing.
 */

export const DOMAIN_US = 'US-FCC';

interface FeedIndex {
  domain: string;
  channel_plan: string;
  generated_at: string;
  cell_deg: number;
  cells: Record<string, { stations: number }>;
}

export interface OccupancyResult {
  /** Null when there is no location, or nothing cached to answer from. */
  exclusions: TvExclusion[] | null;
  /** Channels the pack named that the channel plan could not map. */
  unmapped: number[];
  /** Where the answer came from, for the UI to be honest about. */
  source: 'cache' | 'network' | 'none';
  /** The oldest pack the answer was built from, so staleness is visible. */
  oldestFetchedAt: string | null;
  cellsUsed: string[];
  /** Set when there is a reason there is no answer. */
  reason: string | null;
}

/** "40.7128, -74.0060" or similar. Postcodes are not resolved locally. */
export function parseVenueLocation(text: string | null | undefined): LatLon | null {
  if (!text) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export class RegionalData {
  constructor(private readonly feeds: Feeds, private readonly domain = DOMAIN_US) {}

  private get indexPack(): string {
    return this.domain === DOMAIN_US ? 'regional-us-fcc' : `regional-${this.domain.toLowerCase()}`;
  }

  private cellPack(cell: string): string {
    return `${this.indexPack}-${cell}`;
  }

  /**
   * Bring the venue's cells up to date. Called on link and on a schedule.
   *
   * Every failure here is soft: an offline rig keeps whatever it cached, and a
   * venue with no location set simply has nothing to fetch.
   */
  async refresh(location: LatLon | null): Promise<{ fetched: string[]; failed: string[] }> {
    if (!location) return { fetched: [], failed: [] };

    let index: FeedIndex | null = null;
    try {
      index = (await this.feeds.fetch<FeedIndex>(this.indexPack)).payload;
    } catch (err) {
      log.debug(`[Cloud] Could not read the ${this.domain} feed index: ${(err as Error).message}`);
    }

    const wanted = cellsAround(location);
    // Only cells the index says exist. Nine 404s a week for a coastal venue is
    // a cost with nothing on the other side of it.
    const available = index ? wanted.filter(c => index!.cells?.[c]) : wanted;
    const fetched: string[] = [];
    const failed: string[] = [];

    for (const cell of available) {
      try {
        await this.feeds.fetch<TvCell>(this.cellPack(cell));
        fetched.push(cell);
      } catch (err) {
        failed.push(cell);
        log.debug(`[Cloud] Cell ${cell} unavailable: ${(err as Error).message}`);
      }
    }
    if (fetched.length > 0) {
      log.info(`[Cloud] Regional data: ${fetched.length} cell(s) current for ${this.domain}`);
    }
    return { fetched, failed };
  }

  /**
   * The occupied channels at a location, from cache alone.
   *
   * Cache only, deliberately: this is asked during coordination, which happens
   * when an operator is standing at a rack about to tune a rig. Reaching for the
   * network there would make a show-time action wait on a venue's uplink.
   */
  occupancyAt(location: LatLon | null): OccupancyResult {
    const empty: OccupancyResult = {
      exclusions: null, unmapped: [], source: 'none',
      oldestFetchedAt: null, cellsUsed: [], reason: null,
    };
    if (!location) {
      return { ...empty, reason: 'No venue location is set, so TV occupancy cannot be worked out.' };
    }

    const cells: TvCell[] = [];
    const cellsUsed: string[] = [];
    let oldest: string | null = null;

    for (const cell of cellsAround(location)) {
      const cached = this.feeds.cachedOnly<TvCell>(this.cellPack(cell));
      if (!cached) continue;
      cells.push(cached.payload);
      cellsUsed.push(cell);
      if (!oldest || cached.fetchedAt < oldest) oldest = cached.fetchedAt;
    }

    if (cells.length === 0) {
      return {
        ...empty,
        reason: 'No regional data has been downloaded for this location yet. ' +
                'Connect to the internet once and it will be kept for offline use.',
      };
    }

    const { exclusions, unmapped } = tvExclusions(location, cells);
    return {
      exclusions, unmapped, source: 'cache',
      oldestFetchedAt: oldest, cellsUsed, reason: null,
    };
  }

  /** The exclusions in the shape the solver takes, or an empty list. */
  exclusionRanges(location: LatLon | null): Array<[number, number]> {
    const result = this.occupancyAt(location);
    return result.exclusions ? exclusionRangesKHz(result.exclusions) : [];
  }
}
