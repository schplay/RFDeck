import { describe, it, expect } from 'vitest';
import { findIntermodHits, intermodSignature, hitsForChannel, IntermodSource } from './intermod';

// Intermodulation products, checked against arithmetic that is not in doubt.
//
// Third order, two transmitters:   2·f1 − f2
// Third order, three transmitters: f1 + f2 − f3
// Fifth order, two transmitters:   3·f1 − 2·f2
//
// The numbers below are chosen so the products land exactly on a carrier, so a
// failure means the formula is wrong rather than the tolerance being off by a
// little. Frequencies are kHz throughout RFDeck.

const tx = (id: string, frequencyKHz: number, name = id): IntermodSource =>
  ({ id, name, frequencyKHz });

describe('third-order products from two transmitters', () => {
  it('finds 2·A − B landing on a third channel', () => {
    // A=500000, B=500600 → 2A−B = 499400. Put a victim exactly there.
    const report = findIntermodHits([
      tx('a', 500_000), tx('b', 500_600), tx('victim', 499_400),
    ]);
    const hit = report.hits.find(h => h.victimId === 'victim' && h.kind === '2TX3');
    expect(hit).toBeTruthy();
    expect(hit!.productKHz).toBe(499_400);
    expect(hit!.offsetKHz).toBe(0);
    expect(hit!.causeIds).toEqual(['a', 'b']);
  });

  it('treats the pair as ordered, because 2A−B and 2B−A are different products', () => {
    // 2B−A = 501200, which is a different place entirely.
    const report = findIntermodHits([
      tx('a', 500_000), tx('b', 500_600), tx('victim', 501_200),
    ]);
    const hit = report.hits.find(h => h.victimId === 'victim');
    expect(hit).toBeTruthy();
    expect(hit!.causeIds).toEqual(['b', 'a']);
  });

  it('says which transmitters made it, since a warning that does not is not actionable', () => {
    const report = findIntermodHits([
      tx('a', 500_000, 'Vocal 1'), tx('b', 500_600, 'Vocal 2'), tx('v', 499_400, 'Vocal 3'),
    ]);
    const hit = report.hits.find(h => h.victimId === 'v')!;
    expect(hit.formula).toBe('2×Vocal 1 − Vocal 2');
  });
});

describe('third-order products from three transmitters', () => {
  it('finds A + B − C', () => {
    // 500000 + 501000 − 500400 = 500600.
    const report = findIntermodHits([
      tx('a', 500_000), tx('b', 501_000), tx('c', 500_400), tx('victim', 500_600),
    ]);
    const hit = report.hits.find(h => h.victimId === 'victim' && h.kind === '3TX3');
    expect(hit).toBeTruthy();
    expect(hit!.productKHz).toBe(500_600);
  });

  it('is skipped, and says so, on a rig too large to search cubically', () => {
    // The search is cubic. Stalling the event loop on a server carrying live
    // telemetry would be a worse outcome than not knowing.
    const many = Array.from({ length: 90 }, (_, i) => tx(`t${i}`, 500_000 + i * 25));
    const report = findIntermodHits(many);
    expect(report.truncated).toBe(true);
    expect(report.hits.every(h => h.kind !== '3TX3')).toBe(true);
  });
});

describe('fifth-order products', () => {
  it('are not reported unless asked for, being far weaker', () => {
    // 3·500000 − 2·500300 = 499400.
    const sources = [tx('a', 500_000), tx('b', 500_300), tx('victim', 499_400)];
    const off = findIntermodHits(sources);
    expect(off.hits.some(h => h.order === 5)).toBe(false);

    const on = findIntermodHits(sources, { includeFifthOrder: true });
    expect(on.hits.some(h => h.order === 5 && h.victimId === 'victim')).toBe(true);
  });
});

describe('what counts as a hit', () => {
  it('reports a product inside the guard band', () => {
    // 2A−B = 499400; victim 60 kHz away, inside the default 100 kHz.
    const report = findIntermodHits([
      tx('a', 500_000), tx('b', 500_600), tx('victim', 499_460),
    ]);
    expect(report.hits.some(h => h.victimId === 'victim')).toBe(true);
  });

  it('ignores one the receiver would reject anyway', () => {
    // 400 kHz out is well outside a typical front end.
    const report = findIntermodHits([
      tx('a', 500_000), tx('b', 500_600), tx('victim', 499_800),
    ]);
    expect(report.hits.some(h => h.victimId === 'victim')).toBe(false);
  });

  it('takes the guard from the caller, because 100 kHz is a generalisation', () => {
    const sources = [tx('a', 500_000), tx('b', 500_600), tx('victim', 499_800)];
    expect(findIntermodHits(sources, { guardKHz: 500 })
      .hits.some(h => h.victimId === 'victim')).toBe(true);
  });

  it('never blames a transmitter for a product it helped make', () => {
    // 2A−B where the victim IS A is arithmetically real and operationally
    // meaningless: that carrier is already transmitting there.
    const report = findIntermodHits([tx('a', 500_000), tx('b', 500_000)]);
    expect(report.hits).toHaveLength(0);
  });

  it('reports the worst one first', () => {
    const report = findIntermodHits([
      tx('a', 500_000), tx('b', 500_600),
      tx('near', 499_400),   // dead on
      tx('far', 499_330),    // 70 kHz out
    ]);
    const offsets = report.hits.map(h => Math.abs(h.offsetKHz));
    expect(offsets).toEqual([...offsets].sort((x, y) => x - y));
  });
});

describe('channels that have not reported a frequency', () => {
  it('are left out rather than treated as sitting at zero', () => {
    // A carrier at 0 would invent products across the entire band.
    const report = findIntermodHits([
      tx('a', 500_000), tx('b', 500_600), tx('unknown', 0),
    ]);
    expect(report.sourceCount).toBe(2);
    expect(report.hits.every(h => h.victimId !== 'unknown')).toBe(true);
  });
});

describe('the plans an operator will actually have', () => {
  it('flags evenly spaced carriers, which are the classic trap', () => {
    // Equal spacing is the worst case, not the tidy one: with spacing d,
    // 2·f2 − f3 lands exactly on f1, and so on down the line. Anyone who tunes
    // a rack to round numbers an even step apart has built this on purpose
    // without meaning to, which is precisely the mistake worth catching.
    const evenly = [500_000, 500_800, 501_600, 502_400].map((f, i) => tx(`t${i}`, f));
    const report = findIntermodHits(evenly);
    expect(report.hits.length).toBeGreaterThan(0);
    // 2×501600 − 502400 = 500800, dead on t1.
    expect(report.hits.some(h => h.offsetKHz === 0)).toBe(true);
  });

  it('stays quiet on a plan that is actually clean', () => {
    // Deliberately unequal spacing. A quiet answer has to be reachable, or the
    // warning means nothing when it appears.
    const clean = [500_000, 505_250, 505_320, 505_520].map((f, i) => tx(`t${i}`, f));
    expect(findIntermodHits(clean).hits).toHaveLength(0);
  });
});

describe('the signature', () => {
  it('is stable across ordering, so telemetry churn does not recompute', () => {
    const a = [tx('x', 500_000), tx('y', 501_000)];
    const b = [tx('y', 501_000), tx('x', 500_000)];
    expect(intermodSignature(a)).toBe(intermodSignature(b));
  });

  it('changes when something is re-tuned, which is the only time it matters', () => {
    const before = intermodSignature([tx('x', 500_000)]);
    const after  = intermodSignature([tx('x', 500_025)]);
    expect(after).not.toBe(before);
  });
});

describe('hitsForChannel', () => {
  it('narrows the report to one channel, for a warning on its card', () => {
    const report = findIntermodHits([
      tx('a', 500_000), tx('b', 500_600), tx('victim', 499_400),
    ]);
    expect(hitsForChannel(report, 'victim').length).toBeGreaterThan(0);
    expect(hitsForChannel(report, 'a')).toHaveLength(0);
  });
});
