import { describe, it, expect } from 'vitest';
import { coordinate, worstMargin, type CoordinationTransmitter } from './solver';
import { profileFor, profileFromLimits, candidateBands, familyOf, normaliseBandCode } from './profiles';
import { findIntermodHits } from '../intermod';

const ad = (id: string, code = 'G57', currentKHz?: number, extra: Partial<CoordinationTransmitter> = {}): CoordinationTransmitter => ({
  id, name: id, profile: profileFor('shure-ad', code)!, currentKHz, ...extra,
});

/**
 * Independent check: the plan must be clean by the engine that raises the
 * alerts. A plan that could not clear three-transmitter products is checked
 * for two-transmitter ones only — that is what it claims.
 */
function assertClean(plan: ReturnType<typeof coordinate>, guard = 100) {
  const report = findIntermodHits(
    plan.assignments.map(a => ({ id: a.id, name: a.name, frequencyKHz: a.frequencyKHz })),
    { guardKHz: guard, maxSourcesForThreeTx: plan.threeTxCleared ? undefined : 0 },
  );
  expect(report.hits).toEqual([]);
}

describe('profiles', () => {
  it('reads a Shure band with its gap as two segments', () => {
    const p = profileFor('shure-ad', 'G57')!;
    expect(p.segmentsKHz).toEqual([[470_000, 608_000], [614_000, 616_000]]);
    expect(p.stepKHz).toBe(25);
    expect(p.spacingKHz).toEqual({ standard: 350, dense: 125 });
    expect(p.assumed).toEqual([]);
  });

  it('accepts the padded, braced form Shure actually sends', () => {
    expect(normaliseBandCode('{G55 }')).toBe('G55');
    expect(profileFor('shure-ad', '{G55 }')?.code).toBe('G55');
  });

  it('says which figures were chosen rather than read', () => {
    expect(profileFor('senn-g3g4', 'A')!.assumed).toEqual(['spacing']);
    expect(profileFor('senn-ewdx', 'Q1-9')!.assumed).toEqual(['step']);
    expect(profileFor('senn-d6000', 'A1-A4')!.assumed).toEqual([]);
  });

  it('builds a profile from limits the device reported', () => {
    const p = profileFromLimits('senn-d6000', 470_100, 713_900, 25);
    expect(p.segmentsKHz).toEqual([[470_100, 713_900]]);
    expect(p.spacingKHz).toEqual({ standard: 400, dense: 200 });
  });

  it('offers every band containing a carrier, never a single guess', () => {
    expect(candidateBands('shure-ulxd', 540_000)).toEqual(
      expect.arrayContaining(['H50', 'H51', 'H52', 'H54', 'G55', 'G56']),
    );
    expect(candidateBands('shure-ulxd', 540_000)).not.toContain('G50'); // ends at 534
  });

  it('maps inventory rows to families and refuses what it cannot tune', () => {
    expect(familyOf('Shure', 'AD4Q')).toBe('shure-ad');
    expect(familyOf('Shure', 'ULXD4D')).toBe('shure-ulxd');
    expect(familyOf('Sennheiser', 'EWDX EM 4')).toBe('senn-ewdx');
    expect(familyOf('Sennheiser', 'EM 6000')).toBe('senn-d6000');
    expect(familyOf('Sennheiser', 'EW G3/G4')).toBe('senn-g3g4');
    expect(familyOf('Shure', 'P10T')).toBeNull();
  });
});

describe('coordinate', () => {
  it('places a small rig with nothing landing on anything', () => {
    const plan = coordinate({ transmitters: [ad('a'), ad('b'), ad('c'), ad('d'), ad('e')] });
    expect(plan.complete).toBe(true);
    expect(plan.assignments).toHaveLength(5);
    assertClean(plan);
    // Spacing respected.
    const f = plan.assignments.map(a => a.frequencyKHz).sort((x, y) => x - y);
    for (let i = 1; i < f.length; i++) expect(f[i] - f[i - 1]).toBeGreaterThanOrEqual(350);
    // On the grid, in the band.
    for (const x of f) { expect(x % 25).toBe(0); expect(x).toBeGreaterThanOrEqual(470_000); expect(x).toBeLessThanOrEqual(616_000); }
  });

  it('never produces the evenly-spaced trap', () => {
    // Equal spacing is exactly where 2A−B lands on C. A solver that packs
    // carriers on a regular grid is wrong, however tidy it looks.
    const plan = coordinate({ transmitters: Array.from({ length: 8 }, (_, i) => ad(`t${i}`)) });
    expect(plan.complete).toBe(true);
    assertClean(plan);
    expect(plan.worstMarginKHz).toBeGreaterThan(100);
  });

  it('leaves a clean rig alone', () => {
    // 2×500.000 − 501.000 = 499.000, far from anything.
    const plan = coordinate({ transmitters: [ad('a', 'G57', 500_000), ad('b', 'G57', 501_000), ad('c', 'G57', 503_500)] });
    expect(plan.complete).toBe(true);
    expect(plan.moves).toBe(0);
    expect(plan.assignments.map(a => a.frequencyKHz)).toEqual([500_000, 501_000, 503_500]);
  });

  it('moves the fewest transmitters that clear a dirty rig', () => {
    // 2×500.000 − 500.500 = 499.500: c is sitting on a product of a and b.
    const plan = coordinate({ transmitters: [ad('a', 'G57', 500_000), ad('b', 'G57', 500_500), ad('c', 'G57', 499_500)] });
    expect(plan.complete).toBe(true);
    assertClean(plan);
    expect(plan.moves).toBeLessThanOrEqual(1);
    expect(plan.assignments.find(a => a.moved)!.previousKHz).toBeDefined();
  });

  it('keeps out of the band gap and the exclusions', () => {
    const plan = coordinate({
      transmitters: [ad('a'), ad('b'), ad('c')],
      exclusionsKHz: [[470_000, 606_000]], // only 606–608 and 614–616 remain
    });
    expect(plan.complete).toBe(true);
    for (const a of plan.assignments) {
      const f = a.frequencyKHz;
      expect((f >= 606_000 && f <= 608_000) || (f >= 614_000 && f <= 616_000)).toBe(true);
    }
  });

  it('reports a transmitter with nowhere legal to go, and places the rest', () => {
    const plan = coordinate({
      transmitters: [ad('a'), ad('b', 'G62')], // G62 is 510–530
      exclusionsKHz: [[510_000, 530_000]],
    });
    expect(plan.complete).toBe(false);
    expect(plan.unassigned).toEqual([{ id: 'b', name: 'b', reason: expect.stringContaining('no legal frequency') }]);
    expect(plan.assignments.map(a => a.id)).toEqual(['a']);
  });

  it('treats locked carriers as constraints and never moves them', () => {
    const plan = coordinate({ transmitters: [
      ad('feed', 'G57', 500_000, { locked: true }),
      ad('a', 'G57', 500_100), // too close to the lock: must move
      ad('b'),
    ] });
    expect(plan.complete).toBe(true);
    assertClean(plan);
    const feed = plan.assignments.find(a => a.id === 'feed')!;
    expect(feed.frequencyKHz).toBe(500_000);
    expect(feed.moved).toBe(false);
    expect(plan.assignments.find(a => a.id === 'a')!.moved).toBe(true);
  });

  it('reports two locked carriers that conflict rather than resolving them', () => {
    const plan = coordinate({ transmitters: [
      ad('x', 'G57', 500_000, { locked: true }),
      ad('y', 'G57', 500_050, { locked: true }),
    ] });
    expect(plan.unassigned).toEqual([{ id: 'y', name: 'y', reason: expect.stringContaining('locked') }]);
  });

  it('uses the larger spacing across families and the dense figure within one', () => {
    const ewdx = profileFor('senn-ewdx', 'Q1-9')!;
    const plan = coordinate({ transmitters: [
      { id: 'dx1', name: 'dx1', profile: ewdx },
      { id: 'dx2', name: 'dx2', profile: ewdx, dense: true },
      ad('ad1', 'G57'),
    ] });
    expect(plan.complete).toBe(true);
    const f = Object.fromEntries(plan.assignments.map(a => [a.id, a.frequencyKHz]));
    // EW-DX to EW-DX: the non-dense one still demands 600.
    expect(Math.abs(f.dx1 - f.dx2)).toBeGreaterThanOrEqual(600);
    // EW-DX to AD: max(600, 350).
    expect(Math.abs(f.dx1 - f.ad1)).toBeGreaterThanOrEqual(600);
    // EW-DX stays on its 600 kHz preset grid from 470.200.
    expect((f.dx1 - 470_200) % 600).toBe(0);
  });

  it('is deterministic', () => {
    const rig = () => Array.from({ length: 12 }, (_, i) => ad(`t${i}`, i % 2 ? 'G57' : 'H54'));
    expect(coordinate({ transmitters: rig() })).toEqual(coordinate({ transmitters: rig() }));
  });

  it('coordinates a realistic rig quickly and cleanly', () => {
    const tx: CoordinationTransmitter[] = [
      ...Array.from({ length: 16 }, (_, i) => ad(`ad${i}`, 'G57')),
      ...Array.from({ length: 8 },  (_, i) => ({ id: `dx${i}`, name: `dx${i}`, profile: profileFor('senn-ewdx', 'Q1-9')! })),
      ...Array.from({ length: 6 },  (_, i) => ({ id: `g4${i}`, name: `g4${i}`, profile: profileFor('senn-g3g4', 'A')! })),
    ];
    const t0 = Date.now();
    const plan = coordinate({ transmitters: tx });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(plan.complete).toBe(true);
    assertClean(plan);
    expect(plan.worstMarginKHz).toBeGreaterThan(100);
  });

  it('clears three-transmitter products when the rig allows it', () => {
    const plan = coordinate({ transmitters: Array.from({ length: 16 }, (_, i) => ad(`t${i}`)) });
    expect(plan.complete).toBe(true);
    expect(plan.threeTxCleared).toBe(true);
    expect(plan.worstThreeTxMarginKHz).toBeGreaterThan(100);
    assertClean(plan);
  });

  it('places a dense rig without them, and says so', () => {
    // ~26 carriers is where a 146 MHz band stops having room for a rig
    // clear of f1 + f2 − f3. Beyond that the honest plan clears 2·f1 − f2
    // and reports the rest.
    const plan = coordinate({ transmitters: Array.from({ length: 40 }, (_, i) => ad(`t${i}`)) });
    expect(plan.complete).toBe(true);
    expect(plan.threeTxCleared).toBe(false);
    expect(plan.worstMarginKHz).toBeGreaterThan(100);
    assertClean(plan);
    // Asked to insist, it reports instead.
    const strict = coordinate({ transmitters: Array.from({ length: 40 }, (_, i) => ad(`t${i}`)), threeTx: 'required' });
    expect(strict.complete).toBe(false);
    expect(strict.threeTxCleared).toBe(true);
  });

  it('stops at the budget and says so, keeping what it placed', () => {
    const plan = coordinate({ transmitters: Array.from({ length: 40 }, (_, i) => ad(`t${i}`, 'G62')), maxNodes: 200, threeTx: 'required' });
    expect(plan.budgetExhausted).toBe(true);
    expect(plan.complete).toBe(false);
    expect(plan.assignments.length).toBeGreaterThan(0);
    expect(plan.unassigned.every(u => u.reason.includes('budget'))).toBe(true);
  });
});

describe('worstMargin', () => {
  it('is null with nothing to mix', () => {
    expect(worstMargin([500_000])).toBeNull();
  });
  it('finds the product sitting on a carrier', () => {
    // 2×500.000 − 500.500 = 499.500 exactly.
    expect(worstMargin([500_000, 500_500, 499_500])).toBe(0);
  });
  it('finds the three-transmitter product, and only in its own class', () => {
    // 500 + 504 − 501 = 503: a carrier sits there.
    expect(worstMargin([500_000, 504_000, 501_000, 503_000], { twoTx: false })).toBe(0);
    // 2×504 − 503 = 505, 2×503 − 504 = 502 … the closest 2TX product is 1 MHz off.
    expect(worstMargin([500_000, 504_000, 501_000, 503_000], { threeTx: false })).toBe(1000);
  });
});
