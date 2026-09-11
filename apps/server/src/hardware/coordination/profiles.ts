// Device profiles for frequency coordination: what a transmitter is allowed
// to be tuned to, and how close two of them may sit.
//
// Every number here was read from a manufacturer document or from the device
// itself; docs/COORDINATION_PROFILES.md says which. Nothing in this file is a
// guess, and the two places where a figure had to be *chosen* rather than
// read — the G3/G4 spacing and the EW-DX tuning step — are flagged on the
// profile so the UI can say so instead of pretending.

/** The families RFDeck can coordinate, as far as tuning rules go. */
export type CoordinationFamily =
  | 'shure-ad'     // Axient Digital
  | 'shure-ulxd'
  | 'shure-qlxd'
  | 'shure-slxd'
  | 'senn-ewdx'
  | 'senn-d6000'
  | 'senn-g3g4';

export interface BandProfile {
  family: CoordinationFamily;
  /** The band code as the manufacturer prints it, e.g. "G57" or "Q1-9". */
  code: string;
  /**
   * Tunable spans, kHz, inclusive. More than one when the band has a gap —
   * a plan landing in 608–614 MHz on a G57 is wrong, not merely suboptimal.
   */
  segmentsKHz: Array<[number, number]>;
  /** Tuning grid, kHz. */
  stepKHz: number;
  /** Minimum carrier-to-carrier spacing, kHz, in each transmission mode. */
  spacingKHz: { standard: number; dense?: number };
  /**
   * Which figures were read from a document and which were chosen.
   *
   * Shown to the operator: a plan built on an assumed spacing is still a
   * plan, but it is a different kind of promise.
   */
  assumed: Array<'step' | 'spacing'>;
}

/** How a device came to have a band, kept so a person's answer is never overruled. */
export type BandSource = 'reported' | 'declared';

// ── Family-level rules ──────────────────────────────────────────────────────

interface FamilyRules {
  stepKHz: number;
  spacingKHz: { standard: number; dense?: number };
  assumed: Array<'step' | 'spacing'>;
}

const FAMILY_RULES: Record<CoordinationFamily, FamilyRules> = {
  // AD4 user guide: 25 kHz step; 350 kHz standard, 125 kHz High Density.
  'shure-ad':   { stepKHz: 25, spacingKHz: { standard: 350, dense: 125 }, assumed: [] },
  // ULX-D user guide: "reduced from 350 kHz to 125 kHz" in High Density.
  'shure-ulxd': { stepKHz: 25, spacingKHz: { standard: 350, dense: 125 }, assumed: [] },
  // QLX-D publishes no spacing figure. It quotes the same 17 systems per
  // 6 MHz TV channel as ULX-D standard mode, so ULX-D's figure is used and
  // said to be an assumption.
  'shure-qlxd': { stepKHz: 25, spacingKHz: { standard: 350 }, assumed: ['spacing'] },
  // SLX-D: nothing read from Shure's own document yet (page unreachable).
  'shure-slxd': { stepKHz: 25, spacingKHz: { standard: 350 }, assumed: ['step', 'spacing'] },
  // EW-DX: equidistant grid, 600 kHz standard / 300 kHz Link Density (design
  // guide). The manual tuning step is not published anywhere accessible;
  // the factory presets sit on a 600 kHz grid so that is the grid used until
  // the rig says otherwise.
  'senn-ewdx':  { stepKHz: 600, spacingKHz: { standard: 600, dense: 300 }, assumed: ['step'] },
  // SSC v2.2 §8.17: inc 25 kHz. Manual: 400 kHz LR, 200 kHz LD.
  'senn-d6000': { stepKHz: 25, spacingKHz: { standard: 400, dense: 200 }, assumed: [] },
  // G4 technical data: 25 kHz steps. Sennheiser publishes no spacing figure
  // for G3/G4 — banks are "calculated to be intermodulation-free" and that
  // is all. 400 kHz is the conservative choice, matching Digital 6000's
  // long-range figure, and is labelled as chosen.
  'senn-g3g4':  { stepKHz: 25, spacingKHz: { standard: 400 }, assumed: ['spacing'] },
};

// ── Band tables ─────────────────────────────────────────────────────────────
//
// MHz as printed in the source, converted once here. Gaps are separate
// segments.

const MHz = (lo: number, hi: number): [number, number] => [Math.round(lo * 1000), Math.round(hi * 1000)];

type BandTable = Record<string, Array<[number, number]>>;

// Shure AD4D/AD4Q user guide, "Receiver Frequency Bands".
const SHURE_AD: BandTable = {
  G53: [MHz(470, 510)],
  G54: [MHz(479, 565)],
  G55: [MHz(470, 608), MHz(614, 636)],
  G56: [MHz(470, 636)],
  G57: [MHz(470, 608), MHz(614, 616)],
  G62: [MHz(510, 530)],
  H54: [MHz(520, 636)],
  K53: [MHz(606, 608), MHz(614, 698)],
  K54: [MHz(606, 608), MHz(614, 616), MHz(653, 663)],
  K55: [MHz(606, 694)],
  K56: [MHz(606, 714)],
  K57: [MHz(606, 790)],
  K58: [MHz(622, 698)],
  L54: [MHz(630, 787)],
  L60: [MHz(630.125, 697.875)],
  P55: [MHz(694, 703), MHz(748, 758), MHz(803, 806)],
  R52: [MHz(794, 806)],
  JB:  [MHz(806, 810)],
  X51: [MHz(925, 937.5)],
  X55: [MHz(941, 960)],
  Z16: [MHz(1240, 1260)],
};

// Shure ULX-D user guide, "Frequency Range and Transmitter Output Power".
// The guide's table runs onto a page that was not captured; the codes here
// are the ones read.
const SHURE_ULXD: BandTable = {
  G50: [MHz(470, 534)], G51: [MHz(470, 534)], G52: [MHz(479, 534)], G53: [MHz(470, 510)],
  G54: [MHz(479, 565)], G55: [MHz(470, 608), MHz(614, 636)], G56: [MHz(470, 636)],
  G57: [MHz(470, 608)], G62: [MHz(510, 530)], G65: [MHz(470, 606)], G66: [MHz(487, 606)],
  H50: [MHz(534, 598)], H51: [MHz(534, 598)], H52: [MHz(534, 565)], H54: [MHz(520, 636)],
  J50: [MHz(572, 636)], J50A: [MHz(572, 608)], J51: [MHz(572, 636)], K51: [MHz(606, 670)],
  L50: [MHz(632, 696)], L51: [MHz(632, 696)], L53: [MHz(632, 714)], M19: [MHz(694, 703)],
  P51: [MHz(710, 782)], R51: [MHz(800, 810)], AB: [MHz(770, 810)], Q12: [MHz(748, 758)],
  Q51: [MHz(794, 806)],
};

// Shure QLX-D user guide, same table.
const SHURE_QLXD: BandTable = {
  G50: [MHz(470, 534)], G51: [MHz(470, 534)], G52: [MHz(479, 534)], G53: [MHz(470, 510)],
  G62: [MHz(510, 530)], H50: [MHz(534, 598)], H51: [MHz(534, 598)], H52: [MHz(534, 565)],
  H53: [MHz(534, 598)], J50: [MHz(572, 636)], J51: [MHz(572, 636)], JB: [MHz(806, 810)],
  K51: [MHz(606, 670)], K52: [MHz(606, 670)], L50: [MHz(632, 696)], L51: [MHz(632, 696)],
  L52: [MHz(632, 694)], L53: [MHz(632, 714)], M19: [MHz(694, 703)], P51: [MHz(710, 782)],
  P52: [MHz(710, 782)], Q12: [MHz(748, 758)], Q51: [MHz(794, 806)],
  S50: [MHz(823, 832), MHz(863, 865)], V50: [MHz(174, 216)], V51: [MHz(174, 216)],
  V52: [MHz(174, 210)], X51: [MHz(925, 937.5)], X52: [MHz(902, 928)],
  X53: [MHz(902, 907.5), MHz(915, 928)], X54: [MHz(915, 928)], Z17: [MHz(1492, 1525)],
  Z18: [MHz(1785, 1805)], Z19: [MHz(1785, 1800)], Z20: [MHz(1790, 1805)],
};

// Sennheiser EW-D / EW-DX instruction manual, product listing.
const SENN_EWDX: BandTable = {
  'Q1-9':  [MHz(470.2, 550)],
  'R1-9':  [MHz(520, 607.8)],
  'R4-9':  [MHz(552, 607.8)],
  'S1-10': [MHz(606.2, 693.8)],
  'S2-10': [MHz(614.2, 693.8)],
  'S4-10': [MHz(630, 693.8)],
  'U1/5':  [MHz(823.2, 831.8), MHz(863.2, 864.8)],
  'V3-4':  [MHz(925.2, 937.3)],
  'V5-7':  [MHz(941.7, 951.8), MHz(953.05, 956.05), MHz(956.65, 959.65)],
  'Y1-3':  [MHz(1785.2, 1799.8)],
};

// Sennheiser EK IEM G4 technical data. K+ and 1G8 exist but their ranges
// were not in the pages read, so they are not here.
const SENN_G3G4: BandTable = {
  A1: [MHz(470, 516)], A: [MHz(516, 558)], AS: [MHz(520, 558)], G: [MHz(566, 608)],
  GB: [MHz(606, 648)], B: [MHz(626, 668)], C: [MHz(734, 776)], 'C-TH': [MHz(748.2, 757.8)],
  D: [MHz(780, 822)], E: [MHz(823, 865)],
};

// Digital 6000 transmitter bands, from the manual. The receiver's own range
// comes from the device (`profileFromLimits`), so these are only for a rig
// where the operator wants the plan held inside what the packs can do.
const SENN_D6000: BandTable = {
  'A1-A4': [MHz(470.2, 558)],
  'A5-A8': [MHz(550, 638)],
  'B1-B4': [MHz(630, 718)],
};

const TABLES: Record<CoordinationFamily, BandTable> = {
  'shure-ad':   SHURE_AD,
  'shure-ulxd': SHURE_ULXD,
  'shure-qlxd': SHURE_QLXD,
  'shure-slxd': {},
  'senn-ewdx':  SENN_EWDX,
  'senn-d6000': SENN_D6000,
  'senn-g3g4':  SENN_G3G4,
};

// ── Lookup ──────────────────────────────────────────────────────────────────

/** Band codes are printed with trailing padding by Shure ("{G55 }"); compare loosely. */
export function normaliseBandCode(code: string): string {
  return code.trim().replace(/[{}]/g, '').trim().toUpperCase();
}

/** The profile for a band code, or null if the code is not in the table. */
export function profileFor(family: CoordinationFamily, code: string): BandProfile | null {
  const table = TABLES[family];
  const wanted = normaliseBandCode(code);
  const key = Object.keys(table).find(k => k.toUpperCase() === wanted);
  if (!key) return null;
  const rules = FAMILY_RULES[family];
  return {
    family, code: key,
    segmentsKHz: table[key].map(s => [s[0], s[1]] as [number, number]),
    stepKHz: rules.stepKHz,
    spacingKHz: { ...rules.spacingKHz },
    assumed: [...rules.assumed],
  };
}

/**
 * A profile built from limits the device itself reported.
 *
 * Digital 6000 publishes `min`, `max` and `inc` on `/rx1/carrier`; that is
 * better than any table, so it is used as-is with the family's spacing.
 */
export function profileFromLimits(
  family: CoordinationFamily, minKHz: number, maxKHz: number, stepKHz?: number,
): BandProfile {
  const rules = FAMILY_RULES[family];
  return {
    family, code: `${minKHz / 1000}–${maxKHz / 1000} MHz`,
    segmentsKHz: [[minKHz, maxKHz]],
    stepKHz: stepKHz ?? rules.stepKHz,
    spacingKHz: { ...rules.spacingKHz },
    assumed: stepKHz ? rules.assumed.filter(a => a !== 'step') : [...rules.assumed],
  };
}

/** Every band code known for a family, for the "declare band" control. */
export function bandCodes(family: CoordinationFamily): string[] {
  return Object.keys(TABLES[family]);
}

/**
 * The bands whose range contains this carrier.
 *
 * For a device that will not report its band this is the honest offer: a
 * ULX-D on 540.000 MHz is in G50, H50 *and* H52, so the answer is a list for
 * a person to choose from, never a silent pick.
 */
export function candidateBands(family: CoordinationFamily, frequencyKHz: number): string[] {
  return Object.entries(TABLES[family])
    .filter(([, segs]) => segs.some(([lo, hi]) => frequencyKHz >= lo && frequencyKHz <= hi))
    .map(([code]) => code);
}

/**
 * Which coordination family an inventory row belongs to, from the fields
 * RFDeck already uses to choose a protocol. Null when it is not one RFDeck
 * can tune — a PSM1000, a UHF-R — so the caller can leave it out of the
 * plan by name rather than by accident.
 */
export function familyOf(manufacturer: string, model: string): CoordinationFamily | null {
  const m = model ?? '';
  if (/shure/i.test(manufacturer ?? '')) {
    if (/AD4/i.test(m))            return 'shure-ad';
    if (/ULX-?D/i.test(m))         return 'shure-ulxd';
    if (/QLX-?D/i.test(m))         return 'shure-qlxd';
    if (/SLX-?D/i.test(m))         return 'shure-slxd';
    return null;
  }
  if (/EM ?6000|6000/i.test(m))    return 'senn-d6000';
  if (/EW-?DX|EWDX/i.test(m))      return 'senn-ewdx';
  if (/G3|G4/i.test(m))            return 'senn-g3g4';
  return null;
}

/** Whether this family's receivers report their band over the protocol. */
export function bandIsReported(family: CoordinationFamily): boolean {
  switch (family) {
    case 'shure-ad':
    case 'senn-ewdx':
    case 'senn-d6000': // reports its limits rather than a code
      return true;
    case 'shure-slxd': // Companion says so; not confirmed against Shure
    case 'shure-ulxd':
    case 'shure-qlxd':
    case 'senn-g3g4':
      return false;
  }
}
