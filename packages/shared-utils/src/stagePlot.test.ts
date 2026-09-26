import { describe, it, expect } from 'vitest';
import {
  stageCoord, pointToStage, arrangeEvenly, STAGE_MAX, STAGE_CENTRE,
} from './stagePlot';

// Stage-plot coordinates. Two of these guard properties that break something
// non-obvious if they regress: an integer-only space (the show file's content hash
// cannot hold a float) and null meaning unplaced (rather than the upstage corner).

describe('stageCoord', () => {
  it('keeps a value in range', () => {
    expect(stageCoord(0)).toBe(0);
    expect(stageCoord(500)).toBe(500);
    expect(stageCoord(STAGE_MAX)).toBe(STAGE_MAX);
  });

  it('rounds, because a float would break the show file content hash', () => {
    // Not tidiness: Meros hashes a canonical JSON form and RFDeck reproduces it to
    // tell a benign conflict from a real one. PHP and JS can render the same float
    // differently, so a float here makes two identical documents look different.
    expect(stageCoord(320.4)).toBe(320);
    expect(stageCoord(699.5)).toBe(700);
    expect(Number.isInteger(stageCoord(1.000001))).toBe(true);
  });

  it('clamps rather than storing a position off the stage', () => {
    // An out-of-range value would persist and put somebody permanently off the plot.
    expect(stageCoord(-40)).toBe(0);
    expect(stageCoord(4000)).toBe(STAGE_MAX);
  });

  it('keeps unplaced unplaced, rather than moving them to a corner', () => {
    // The trap: Number(null) is 0, so a careless coercion silently places every
    // unplaced performer at the upstage-left corner.
    expect(stageCoord(null)).toBeNull();
    expect(stageCoord(undefined)).toBeNull();
    expect(stageCoord('')).toBeNull();
  });

  it('treats nonsense as unplaced rather than guessing', () => {
    expect(stageCoord('centre stage')).toBeNull();
    expect(stageCoord(Number.NaN)).toBeNull();
    expect(stageCoord({})).toBeNull();
  });
});

describe('pointToStage', () => {
  const surface = { left: 100, top: 50, width: 600, height: 400 };

  it('maps a pointer onto the stage proportionally', () => {
    expect(pointToStage({ x: 400, y: 250 }, surface)).toEqual({ x: 500, y: 500 });
    expect(pointToStage({ x: 100, y: 50 }, surface)).toEqual({ x: 0, y: 0 });
    expect(pointToStage({ x: 700, y: 450 }, surface)).toEqual({ x: STAGE_MAX, y: STAGE_MAX });
  });

  it('is independent of the surface size, which is the whole point', () => {
    // The same relative position on a laptop and a phone must be the same
    // coordinate, or a plot dragged at FOH would read wrong in the wings.
    const laptop = pointToStage({ x: 400, y: 250 }, surface);
    const phone = pointToStage({ x: 175, y: 150 }, { left: 100, top: 100, width: 150, height: 100 });
    expect(phone).toEqual(laptop);
  });

  it('clamps a pointer dragged off the surface', () => {
    expect(pointToStage({ x: -500, y: 10_000 }, surface)).toEqual({ x: 0, y: STAGE_MAX });
  });

  it('returns null for a zero-sized surface instead of dividing by zero', () => {
    // Happens on first paint and while a layout settles; without this everyone
    // lands on the origin.
    expect(pointToStage({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 400 })).toBeNull();
    expect(pointToStage({ x: 10, y: 10 }, { left: 0, top: 0, width: 600, height: 0 })).toBeNull();
  });
});

describe('arrangeEvenly', () => {
  it('gives every performer a distinct spot', () => {
    const spots = arrangeEvenly(12);
    expect(spots).toHaveLength(12);
    expect(new Set(spots.map(s => `${s.x},${s.y}`)).size).toBe(12);
  });

  it('insets from the edges, so nobody starts half off the stage', () => {
    for (const spot of arrangeEvenly(9)) {
      expect(spot.x).toBeGreaterThan(0);
      expect(spot.y).toBeGreaterThan(0);
      expect(spot.x).toBeLessThan(STAGE_MAX);
      expect(spot.y).toBeLessThan(STAGE_MAX);
    }
  });

  it('puts one performer in the middle', () => {
    expect(arrangeEvenly(1)).toEqual([{ x: STAGE_CENTRE, y: STAGE_CENTRE }]);
  });

  it('produces only integers', () => {
    for (const spot of arrangeEvenly(30)) {
      expect(Number.isInteger(spot.x)).toBe(true);
      expect(Number.isInteger(spot.y)).toBe(true);
    }
  });

  it('handles an empty cast', () => {
    expect(arrangeEvenly(0)).toEqual([]);
    expect(arrangeEvenly(-3)).toEqual([]);
  });
});
