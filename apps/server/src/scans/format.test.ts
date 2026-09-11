import { describe, it, expect } from 'vitest';
import {
  toKHz, parsePairs, toGrid, parseScanText, toWwbCsv, exclusionsFromScan, peakHold, levelAt, detectSource,
} from './format';

describe('units', () => {
  it('tells Hz, kHz and MHz apart by magnitude', () => {
    expect(toKHz(470.1)).toBe(470_100);
    expect(toKHz(470_100)).toBe(470_100);
    expect(toKHz(470_100_000)).toBe(470_100);
  });
});

describe('parsePairs', () => {
  it('reads the WWB pair form', () => {
    expect(parsePairs('470.100, -42.1\n470.125, -62.3\n')).toEqual([[470_100, -42.1], [470_125, -62.3]]);
  });

  it('reads the WSM form with its empty percent column', () => {
    const text = 'Frequency;RF level (%);RF level\n470000;;-106\n470025;12;-95\n';
    expect(parsePairs(text)).toEqual([[470_000, -106], [470_025, -95]]);
    expect(detectSource(text)).toBe('wsm');
  });

  it('skips headers, comments and repeated header blocks', () => {
    const text = 'Frequency,Level\n470.100,-90\n# note\nFrequency,Level\n470.125,-91\n';
    expect(parsePairs(text)).toEqual([[470_100, -90], [470_125, -91]]);
  });

  it('accepts a decimal comma when the separator is a semicolon', () => {
    expect(parsePairs('470,100;-90,5\n')).toEqual([[470_100, -90.5]]);
  });
});

describe('toGrid', () => {
  it('uses the smallest spacing as the step and keeps the loudest reading per bin', () => {
    const g = toGrid([[470_000, -100], [470_050, -90], [470_100, -80], [470_100, -70]])!;
    expect(g).toEqual({ startKHz: 470_000, stepKHz: 50, levelsDbm: [-100, -90, -70] });
  });

  it('never goes below 25 kHz, and leaves gaps as null', () => {
    const g = toGrid([[470_000, -100], [470_010, -90], [470_100, -80]])!;
    expect(g.stepKHz).toBe(25);
    expect(g.levelsDbm).toEqual([-90, null, null, null, -80]);
  });

  it('needs at least two points', () => {
    expect(toGrid([[470_000, -100]])).toBeNull();
    expect(parseScanText('nothing here')).toBeNull();
  });
});

describe('toWwbCsv', () => {
  it('writes MHz and dBm pairs with no header, skipping gaps', () => {
    const scan = parseScanText('470000;;-106\n470050;;-95\n')!;
    expect(toWwbCsv(scan)).toBe('470.000,-106.0\n470.050,-95.0\n');
  });

  it('round-trips through its own reader', () => {
    const scan = parseScanText('470.100,-42.1\n470.125,-62.3\n470.150,-65.7\n')!;
    expect(parseScanText(toWwbCsv(scan))).toMatchObject({ startKHz: 470_100, stepKHz: 25, levelsDbm: [-42.1, -62.3, -65.7] });
  });
});

describe('exclusionsFromScan', () => {
  const scan = parseScanText([
    '470.000,-100', '470.025,-100', '470.050,-60', '470.075,-100', '470.100,-100',
    '470.125,-100', '470.150,-100', '470.175,-100', '470.200,-100', '470.225,-100',
    '470.250,-55', '470.275,-58', '470.300,-100',
  ].join('\n'))!;

  it('spans every hot point widened by the margin, merged where they touch', () => {
    expect(exclusionsFromScan(scan, -70, 100)).toEqual([
      [469_950, 470_150],
      [470_150, 470_375],
    ].map(([lo, hi]) => [lo, hi]).reduce<Array<[number, number]>>((acc, [lo, hi]) => {
      // 470.050 ± 100 → 469.950–470.150; 470.250/470.275 ± 100 → 470.150–470.375.
      // They touch at 470.150 and so merge into one span.
      const last = acc[acc.length - 1];
      if (last && lo <= last[1]) { last[1] = hi; return acc; }
      acc.push([lo, hi]); return acc;
    }, []));
    expect(exclusionsFromScan(scan, -70, 100)).toEqual([[469_950, 470_375]]);
  });

  it('separates spans that do not touch', () => {
    expect(exclusionsFromScan(scan, -70, 25)).toEqual([[470_025, 470_075], [470_225, 470_300]]);
  });

  it('is empty when nothing reaches the threshold', () => {
    expect(exclusionsFromScan(scan, -50)).toEqual([]);
  });
});

describe('peakHold and levelAt', () => {
  it('keeps the loudest of several scans on the first grid', () => {
    const a = parseScanText('470.000,-100\n470.025,-80\n470.050,-100\n')!;
    const b = parseScanText('470.000,-90\n470.025,-100\n')!;
    expect(peakHold([a, b])!.levelsDbm).toEqual([-90, -80, -100]);
    expect(levelAt(a, 470_030)).toBe(-80);
    expect(levelAt(a, 471_000)).toBeNull();
  });
});
