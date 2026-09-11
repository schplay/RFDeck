// Spectrum scans: reading the formats the coordination tools exchange,
// writing the one they all import, and turning a scan into exclusions.
//
// A scan is a uniform grid of levels: start, step, and one dBm per point,
// with null where the source had no reading. Every source — a WWB export, a
// WSM export, later a receiver or an RF Explorer — is folded into that one
// shape, so everything downstream (the plot, the coordinator) has a single
// input. See docs/SCANNING.md for where each format was read from.

export interface Scan {
  /** Where it came from: "wwb", "wsm", "csv", later "em6000", "rfexplorer". */
  source: string;
  /** ISO time the scan was taken, if the file said; otherwise when it was imported. */
  takenAt: string;
  startKHz: number;
  stepKHz: number;
  /** One per grid point. Null where the source had no reading. */
  levelsDbm: Array<number | null>;
}

/** Nobody scans finer than this; WWB refuses files that do. */
export const MIN_STEP_KHZ = 25;

/**
 * Frequencies arrive in whichever unit the tool preferred: WWB writes MHz
 * ("470.100, -42.1"), WSM writes kHz ("470000;;-106"), an SDR dump writes Hz.
 * Wireless microphones live between 174 MHz and 2 GHz, so the magnitude
 * says which.
 */
export function toKHz(value: number): number {
  if (value >= 1e7) return value / 1000;   // Hz
  if (value >= 1e4) return value;          // kHz
  return value * 1000;                     // MHz
}

const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

/**
 * Read frequency/level pairs out of a text file.
 *
 * Tolerant of what the tools actually write: header lines, `,` or `;` or
 * whitespace as the separator, a decimal comma, WSM's empty middle column,
 * and repeated header blocks in the middle of an RF Explorer export. The
 * level is the last numeric column on the line.
 */
export function parsePairs(text: string): Array<[kHz: number, dBm: number]> {
  const pairs: Array<[number, number]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // The separator decides whether a comma is a separator or a decimal
    // point: WSM writes "470,100;-90,5", WWB writes "470.100, -42.1".
    const sep = line.includes(';') ? /;/ : line.includes('\t') ? /\t/ : /[, ]+/;
    const cells = line.split(sep).map(c => c.trim());
    if (cells.length < 2) continue;
    const nums = cells.map(c => (NUMBER.test(c) ? Number(c.replace(',', '.')) : NaN));
    const freq = nums[0];
    const level = nums[nums.length - 1];
    if (!Number.isFinite(freq) || !Number.isFinite(level) || freq <= 0) continue;
    pairs.push([toKHz(freq), level]);
  }
  return pairs;
}

/**
 * Fold pairs onto a uniform grid.
 *
 * The step is the smallest spacing seen, never below MIN_STEP_KHZ. A bin
 * with several readings keeps the loudest — a scan is an argument about
 * what is *there*, and averaging would hide the very peak that matters.
 */
export function toGrid(pairs: Array<[number, number]>): Omit<Scan, 'source' | 'takenAt'> | null {
  if (pairs.length < 2) return null;
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  let minGap = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i][0] - sorted[i - 1][0];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap)) return null;
  const stepKHz = Math.max(MIN_STEP_KHZ, Math.round(minGap));
  const startKHz = Math.round(sorted[0][0]);
  const endKHz = Math.round(sorted[sorted.length - 1][0]);
  const points = Math.floor((endKHz - startKHz) / stepKHz) + 1;
  const levelsDbm: Array<number | null> = new Array(points).fill(null);
  for (const [kHz, dBm] of sorted) {
    const i = Math.round((kHz - startKHz) / stepKHz);
    if (i < 0 || i >= points) continue;
    const cur = levelsDbm[i];
    levelsDbm[i] = cur === null ? dBm : Math.max(cur, dBm);
  }
  return { startKHz, stepKHz, levelsDbm };
}

/** Which tool wrote this, from the shape of the file. Only a label. */
export function detectSource(text: string): string {
  const head = text.slice(0, 2000);
  if (/;/.test(head) && /RF level/i.test(head)) return 'wsm';
  if (/;/.test(head)) return 'wsm';
  if (/RF ?Explorer/i.test(head)) return 'rfexplorer';
  return 'csv';
}

export function parseScanText(text: string, takenAt = new Date().toISOString()): Scan | null {
  const grid = toGrid(parsePairs(text));
  if (!grid) return null;
  return { source: detectSource(text), takenAt, ...grid };
}

/**
 * The form Wireless Workbench documents for import — "frequency values,
 * followed by a comma, followed by a signal level", no header — with the
 * frequency in MHz as its own examples show. WSM and IAS read it too.
 */
export function toWwbCsv(scan: Scan): string {
  const lines: string[] = [];
  scan.levelsDbm.forEach((dBm, i) => {
    if (dBm === null) return;
    const mhz = (scan.startKHz + i * scan.stepKHz) / 1000;
    lines.push(`${mhz.toFixed(3)},${dBm.toFixed(1)}`);
  });
  return lines.join('\n') + '\n';
}

/** The level at a frequency, from the nearest grid point; null off the grid or unread. */
export function levelAt(scan: Scan, kHz: number): number | null {
  const i = Math.round((kHz - scan.startKHz) / scan.stepKHz);
  if (i < 0 || i >= scan.levelsDbm.length) return null;
  return scan.levelsDbm[i];
}

/**
 * The spans a coordinator should keep out of: everywhere the scan is at or
 * above the threshold, widened by `marginKHz` on each side and merged.
 *
 * This is what WWB does with its "exclude occupied frequencies" — a
 * peak-hold above a level the operator chooses — and the threshold is the
 * operator's because it depends on the room, the antennas and how much
 * spectrum they can afford to give up.
 */
export function exclusionsFromScan(
  scan: Scan, thresholdDbm: number, marginKHz = 100,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let open: [number, number] | null = null;
  scan.levelsDbm.forEach((dBm, i) => {
    const kHz = scan.startKHz + i * scan.stepKHz;
    const hot = dBm !== null && dBm >= thresholdDbm;
    if (hot) {
      const lo = kHz - marginKHz, hi = kHz + marginKHz;
      if (open && lo <= open[1]) open[1] = hi;
      else { if (open) spans.push(open); open = [lo, hi]; }
    }
  });
  if (open) spans.push(open);
  return spans;
}

/** The loudest reading at each point across several scans, on the first scan's grid. */
export function peakHold(scans: Scan[]): Scan | null {
  if (scans.length === 0) return null;
  const base = scans[0];
  const levels = base.levelsDbm.map((v, i) => {
    let best = v;
    const kHz = base.startKHz + i * base.stepKHz;
    for (let s = 1; s < scans.length; s++) {
      const other = levelAt(scans[s], kHz);
      if (other !== null && (best === null || other > best)) best = other;
    }
    return best;
  });
  return { ...base, source: 'peak-hold', levelsDbm: levels };
}
