import { describe, it, expect } from 'vitest';
import {
  cellIdFor, encodeCellId, decodeCellId, cellsAround,
  pointInPolygon, occupiedChannelsAt, channelSpanKHz, tvExclusions,
  exclusionRangesKHz, TvCell,
} from './tvOccupancy';

// The geography behind "keep out of TV channels licensed here".
//
// Every failure mode in here is silent rather than loud: a wrong cell returns
// real stations from the wrong place, and a wrong polygon test returns a plan
// that looks clean. So the tests are deliberately about the traps, not the
// happy path.

describe('cell ids', () => {
  it('names the south-west corner of the containing cell', () => {
    // SW corner (+40, −74) is the cell covering [40,42) × [−74,−72).
    expect(encodeCellId(40, -74)).toBe('tn40w074');
    expect(decodeCellId('tn40w074')).toEqual({ lat: 40, lon: -74 });
  });

  it('floors, and does not truncate, in the western hemisphere', () => {
    // The trap. Math.trunc(-76.3/2)*2 is −76; the right answer is −78, because
    // the cell spanning [−78,−76) is the one that contains −76.3. Truncating
    // returns a real, adjacent, plausible cell full of the wrong stations — for
    // every longitude in the Americas, which is all of US-FCC.
    expect(cellIdFor({ lat: 40.7, lon: -76.3 })).toBe('tn40w078');
    expect(cellIdFor({ lat: 40.7, lon: -74.0 })).toBe('tn40w074');
    // Manhattan: 40.7128, −74.0060 → the cell starting at −76, not −74.
    expect(cellIdFor({ lat: 40.7128, lon: -74.006 })).toBe('tn40w076');
  });

  it('floors in the southern hemisphere too', () => {
    expect(cellIdFor({ lat: -33.9, lon: 18.4 })).toBe('ts34e018');
    expect(cellIdFor({ lat: -0.5, lon: 0.5 })).toBe('ts02e000');
  });

  it('pads so an id is always the same length', () => {
    expect(encodeCellId(0, 0)).toBe('tn00e000');
    expect(encodeCellId(8, 6)).toBe('tn08e006');
    expect(cellIdFor({ lat: 51.5, lon: -0.12 })).toBe('tn50w002');
  });

  it('round-trips every encodable corner', () => {
    for (const lat of [-88, -34, -2, 0, 2, 40, 88]) {
      for (const lon of [-178, -74, -2, 0, 2, 118, 178]) {
        expect(decodeCellId(encodeCellId(lat, lon))).toEqual({ lat, lon });
      }
    }
  });

  it('refuses something that is not a cell id', () => {
    for (const bad of ['', 'tn40w74', 'n40w074', 'tx40w074', 'tn40x074', 'tn400w074']) {
      expect(() => decodeCellId(bad)).toThrowError(/not a cell id/);
    }
  });
});

describe('the nine-cell window', () => {
  it('returns the centre first, then its eight neighbours', () => {
    const cells = cellsAround({ lat: 40.7, lon: -74.5 });
    expect(cells).toHaveLength(9);
    expect(cells[0]).toBe('tn40w076');
    expect(new Set(cells).size).toBe(9);
  });

  it('spans 6° on each axis, which exceeds any contour reach', () => {
    const cells = cellsAround({ lat: 40.7, lon: -74.5 }).map(decodeCellId);
    const lats = cells.map(c => c.lat);
    const lons = cells.map(c => c.lon);
    expect(Math.max(...lats) - Math.min(...lats)).toBe(4);   // 3 cells of 2°
    expect(Math.max(...lons) - Math.min(...lons)).toBe(4);
  });

  it('flips the hemisphere letter across the prime meridian', () => {
    // A venue just west of Greenwich. Its eastern neighbour is e000, not w000 —
    // which is why neighbours are derived in signed degrees and encoded after,
    // never by editing the id string. US-FCC never exercises this; UK-OFCOM,
    // named as the next domain, does on its first day.
    const cells = cellsAround({ lat: 51.5, lon: -0.5 });
    expect(cells[0]).toBe('tn50w002');
    expect(cells).toContain('tn50e000');
    expect(cells).toContain('tn52e000');
    expect(cells).toContain('tn48w002');
  });

  it('flips across the equator too', () => {
    const cells = cellsAround({ lat: 0.5, lon: 10.5 });
    expect(cells[0]).toBe('tn00e010');
    expect(cells).toContain('ts02e010');
  });

  it('wraps at the antimeridian rather than inventing a cell', () => {
    const cells = cellsAround({ lat: 20, lon: 179 });
    expect(cells[0]).toBe('tn20e178');
    // −180 is the neighbour to the east, not e180.
    expect(cells).toContain('tn20w180');
    expect(cells.every(c => /^t[ns]\d{2}[ew]\d{3}$/.test(c))).toBe(true);
  });

  it('does not walk off the top of the world', () => {
    const cells = cellsAround({ lat: 88, lon: 0 });
    expect(cells.every(c => decodeCellId(c).lat <= 88)).toBe(true);
  });
});

describe('point in polygon', () => {
  // A 1°-square contour around (40,−75)..(41,−74), as [lat, lon] pairs.
  const square: [number, number][] = [[40, -75], [40, -74], [41, -74], [41, -75]];

  it('finds a point inside', () => {
    expect(pointInPolygon({ lat: 40.5, lon: -74.5 }, square)).toBe(true);
  });

  it('rejects points outside, on every side', () => {
    for (const p of [
      { lat: 39.5, lon: -74.5 }, { lat: 41.5, lon: -74.5 },
      { lat: 40.5, lon: -75.5 }, { lat: 40.5, lon: -73.5 },
    ]) {
      expect(pointInPolygon(p, square)).toBe(false);
    }
  });

  it('counts a point on the boundary as inside', () => {
    // A venue on the contour line is inside the protected area as far as the
    // regulator is concerned, so coordination should keep off that channel.
    expect(pointInPolygon({ lat: 40, lon: -74.5 }, square)).toBe(true);
    expect(pointInPolygon({ lat: 40.5, lon: -75 }, square)).toBe(true);
    expect(pointInPolygon({ lat: 40, lon: -75 }, square)).toBe(true);   // a corner
  });

  it('handles a concave contour, which a real service area is', () => {
    // An L shape. The notch must read as outside.
    const ell: [number, number][] = [
      [0, 0], [0, 4], [2, 4], [2, 2], [4, 2], [4, 0],
    ];
    expect(pointInPolygon({ lat: 1, lon: 1 }, ell)).toBe(true);
    expect(pointInPolygon({ lat: 3, lon: 3 }, ell)).toBe(false);
    expect(pointInPolygon({ lat: 3, lon: 1 }, ell)).toBe(true);
  });

  it('treats a degenerate contour as no coverage rather than throwing', () => {
    for (const bad of [[], [[0, 0]], [[0, 0], [1, 1]]] as any[]) {
      expect(pointInPolygon({ lat: 0.5, lon: 0.5 }, bad)).toBe(false);
    }
  });

  it('skips a malformed vertex instead of poisoning the whole test', () => {
    const holed: any = [[40, -75], [40, null], [40, -74], [41, -74], [41, -75]];
    expect(pointInPolygon({ lat: 40.5, lon: -74.5 }, holed)).toBe(true);
  });
});

describe('occupancy across cells', () => {
  const covering = (channel: number, callSign: string, facility?: number): any => ({
    facility_id: facility, call_sign: callSign, rf_channel: channel, service: 'DT',
    lat: null, lon: null,
    contour: [[40, -75], [40, -74], [41, -74], [41, -75]],
  });
  const elsewhere = (channel: number, callSign: string): any => ({
    call_sign: callSign, rf_channel: channel, service: 'DT',
    contour: [[10, -10], [10, -9], [11, -9], [11, -10]],
  });

  const cell = (name: string, stations: any[]): TvCell => ({
    domain: 'US-FCC', channel_plan: 'US', cell: name, cell_deg: 2, stations,
  });

  const venue = { lat: 40.5, lon: -74.5 };

  it('reports only channels whose contour covers the venue', () => {
    const cells = [cell('tn40w076', [covering(26, 'WTEST', 1), elsewhere(31, 'WFAR')])];
    expect(occupiedChannelsAt(venue, cells).map(c => c.rfChannel)).toEqual([26]);
  });

  it('unions across the nine cells and sorts by channel', () => {
    const cells = [
      cell('tn40w076', [covering(31, 'WC', 3)]),
      cell('tn40w074', [covering(14, 'WA', 1)]),
      cell('tn42w076', [covering(26, 'WB', 2)]),
    ];
    expect(occupiedChannelsAt(venue, cells).map(c => c.rfChannel)).toEqual([14, 26, 31]);
  });

  it('counts a station once when it appears in several cells', () => {
    // Meros files a station in every cell its contour overlaps, so a station near
    // a boundary legitimately appears more than once in a nine-cell window.
    const cells = [
      cell('tn40w076', [covering(26, 'WTEST', 12477)]),
      cell('tn40w074', [covering(26, 'WTEST', 12477)]),
      cell('tn42w076', [covering(26, 'WTEST', 12477)]),
    ];
    const occupied = occupiedChannelsAt(venue, cells);
    expect(occupied).toHaveLength(1);
    expect(occupied[0].stations).toHaveLength(1);
  });

  it('keeps two different stations sharing a channel', () => {
    const cells = [cell('tn40w076', [covering(26, 'WONE', 1), covering(26, 'WTWO', 2)])];
    const occupied = occupiedChannelsAt(venue, cells);
    expect(occupied).toHaveLength(1);
    expect(occupied[0].stations.map(s => s.callSign)).toEqual(['WONE', 'WTWO']);
  });

  it('survives rubbish in the pack', () => {
    const cells = [cell('tn40w076', [
      { rf_channel: 'not a number', contour: [[40, -75], [40, -74], [41, -74]] },
      { rf_channel: 0, contour: [[40, -75], [40, -74], [41, -74]] },
      covering(26, 'WGOOD', 1),
    ] as any)];
    expect(occupiedChannelsAt(venue, cells).map(c => c.rfChannel)).toEqual([26]);
  });

  it('reports nothing when we hold no cells', () => {
    expect(occupiedChannelsAt(venue, [])).toEqual([]);
  });
});

describe('the US channel plan', () => {
  it('maps the UHF band a wireless rig actually lives in', () => {
    expect(channelSpanKHz('US', 14)).toEqual([470_000, 476_000]);
    expect(channelSpanKHz('US', 26)).toEqual([542_000, 548_000]);
    expect(channelSpanKHz('US', 36)).toEqual([602_000, 608_000]);
  });

  it('maps VHF across its three discontiguous bands', () => {
    expect(channelSpanKHz('US', 2)).toEqual([54_000, 60_000]);
    expect(channelSpanKHz('US', 4)).toEqual([66_000, 72_000]);
    // 5 and 6 are a separate band: not 72 MHz onwards.
    expect(channelSpanKHz('US', 5)).toEqual([76_000, 82_000]);
    expect(channelSpanKHz('US', 7)).toEqual([174_000, 180_000]);
    expect(channelSpanKHz('US', 13)).toEqual([210_000, 216_000]);
  });

  it('is every channel 6 MHz wide', () => {
    for (let ch = 2; ch <= 51; ch++) {
      const span = channelSpanKHz('US', ch);
      if (span) expect(span[1] - span[0]).toBe(6_000);
    }
  });

  it('returns null for a plan it does not know, rather than guessing', () => {
    // Excluding the wrong six megahertz would produce a plan that looks lawful
    // and is not.
    expect(channelSpanKHz('UK', 26)).toBeNull();
    expect(channelSpanKHz('', 26)).toBeNull();
  });

  it('returns null outside the channel range', () => {
    for (const ch of [0, 1, 52, 99]) expect(channelSpanKHz('US', ch)).toBeNull();
  });
});

describe('exclusions for the solver', () => {
  const cells: TvCell[] = [{
    domain: 'US-FCC', channel_plan: 'US', cell: 'tn40w076', cell_deg: 2,
    stations: [
      { facility_id: 1, call_sign: 'WONE', rf_channel: 26, service: 'DT',
        contour: [[40, -75], [40, -74], [41, -74], [41, -75]] },
      { facility_id: 2, call_sign: 'WTWO', rf_channel: 31, service: 'DT',
        contour: [[40, -75], [40, -74], [41, -74], [41, -75]] },
    ],
  }];
  const venue = { lat: 40.5, lon: -74.5 };

  it('produces kHz ranges in the shape the solver takes', () => {
    const { exclusions, plan } = tvExclusions(venue, cells);
    expect(plan).toBe('US');
    expect(exclusionRangesKHz(exclusions)).toEqual([[542_000, 548_000], [572_000, 578_000]]);
  });

  it('carries the stations, so the exclusion can be explained', () => {
    // An operator told "you cannot use 542–548" will ask why, and "WONE is
    // licensed here" is the answer.
    const { exclusions } = tvExclusions(venue, cells);
    expect(exclusions[0].stations.map(s => s.callSign)).toEqual(['WONE']);
  });

  it('takes the plan from the pack when not told', () => {
    expect(tvExclusions(venue, cells).plan).toBe('US');
  });

  it('reports an unmappable channel instead of dropping it silently', () => {
    // The one outcome worth refusing to hide: a licensed channel quietly omitted
    // produces a plan that looks clean and is not.
    const odd: TvCell[] = [{
      ...cells[0],
      channel_plan: 'MARS',
      stations: [cells[0].stations[0]],
    }];
    const { exclusions, unmapped } = tvExclusions(venue, odd);
    expect(exclusions).toEqual([]);
    expect(unmapped).toEqual([26]);
  });
});
