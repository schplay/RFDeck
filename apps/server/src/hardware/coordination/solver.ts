// Frequency coordination: give every transmitter a carrier that clears the
// others.
//
// Pure and offline, in the same shape as intermod.ts. The physics is the same
// arithmetic that file already does; what this adds is the search. Each
// transmitter has a grid of legal carriers (its band, on its step, minus
// whatever the operator has excluded), and a carrier is acceptable when it
// keeps its distance from every carrier already placed and no third-order
// product of the set lands on any carrier of the set. Most-constrained
// transmitter first, backtracking on conflict.
//
// Two things a solver can get wrong are handled explicitly. It can move
// things that did not need moving: a transmitter's current carrier is tried
// first, so a rig that is already clean produces a plan with zero moves. And
// it can run away: the search carries a node budget and returns the best
// partial plan it found rather than hanging a server that is also carrying
// live telemetry.

import type { BandProfile } from './profiles';

export interface CoordinationTransmitter {
  id: string;
  name: string;
  profile: BandProfile;
  /** High Density / Link Density / LD mode: use the profile's dense spacing. */
  dense?: boolean;
  /** Where it is now, kHz, if it is on the air. */
  currentKHz?: number;
  /**
   * Keep it where it is. A locked carrier is a constraint on everyone else,
   * not a variable — a broadcast feed, a shared-frequency pack that cannot
   * be retuned from here.
   */
  locked?: boolean;
}

export interface CoordinationInput {
  transmitters: CoordinationTransmitter[];
  /** Spans nobody may be placed in, kHz inclusive: a TV channel, a licensed block. */
  exclusionsKHz?: Array<[number, number]>;
  /** How close a product must land to count as a hit, kHz. See intermod.ts. */
  guardKHz?: number;
  includeFifthOrder?: boolean;
  /**
   * Whether three-transmitter products (f1 + f2 − f3) must be cleared.
   *
   * Two-transmitter products are always cleared. Three-transmitter ones
   * number n³/2 and each blocks a window, so past a few dozen carriers a
   * rig that is fully clear of them does not exist in the spectrum
   * available. Default: try with them, and if the rig cannot be placed,
   * retry without — the plan says which it got (`threeTxCleared`).
   */
  threeTx?: 'required' | 'preferred' | 'ignored';
  /** Search budget; the plan says whether it was exhausted. */
  maxNodes?: number;
}

export interface CoordinationAssignment {
  id: string;
  name: string;
  frequencyKHz: number;
  previousKHz?: number;
  moved: boolean;
  locked: boolean;
}

export interface CoordinationPlan {
  assignments: CoordinationAssignment[];
  unassigned: Array<{ id: string; name: string; reason: string }>;
  /** True when every transmitter was placed. */
  complete: boolean;
  /**
   * The closest any two-transmitter product (2·f1 − f2) comes to any carrier
   * in the plan, kHz. The figure to compare two plans by — larger is better —
   * and null when there are too few carriers to make a product.
   */
  worstMarginKHz: number | null;
  /**
   * The same for three-transmitter products (f1 + f2 − f3). Reported
   * separately because a dense rig is placed without clearing these, and a
   * single figure would then say nothing about the products that were.
   */
  worstThreeTxMarginKHz: number | null;
  /** Transmitters the plan would retune. */
  moves: number;
  /**
   * False when the plan clears two-transmitter products only. The rig was
   * too dense to clear three-transmitter products as well, and the
   * intermod report will still show those — that is the truth, not a bug.
   */
  threeTxCleared: boolean;
  nodesExplored: number;
  budgetExhausted: boolean;
}

export const DEFAULT_GUARD_KHZ = 100;
const DEFAULT_MAX_NODES = 200_000;

// ── Forbidden products ──────────────────────────────────────────────────────
//
// Every constraint between a candidate f and the placed carriers S reduces to
// "f is not within guard of some value derived from S":
//
//   2a − b lands on f            → f ∉ {2a − b}
//   2f − a lands on b            → f ∉ {(a + b) / 2}
//   2a − f lands on b            → f ∉ {2a − b}          (same set)
//   a + b − c lands on f         → f ∉ {a + b − c}
//   f + a − b lands on c         → f ∉ {c + b − a}       (same set)
//   a + b − f lands on c         → f ∉ {a + b − c}       (same set)
//   3a − 2b lands on f  (5th)    → f ∉ {3a − 2b}
//   3f − 2a lands on b  (5th)    → f ∉ {(2a + b) / 3}
//   3a − 2f lands on b  (5th)    → f ∉ {(3a − b) / 2}
//
// So the placed set is kept as a bucketed multiset of forbidden values that
// grows and shrinks as the search descends and backtracks.

class ForbiddenSet {
  private buckets = new Map<number, number[]>();
  constructor(private readonly bucketKHz: number) {}

  add(v: number) {
    const k = Math.floor(v / this.bucketKHz);
    const arr = this.buckets.get(k);
    if (arr) arr.push(v); else this.buckets.set(k, [v]);
  }

  remove(v: number) {
    const k = Math.floor(v / this.bucketKHz);
    const arr = this.buckets.get(k);
    if (!arr) return;
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.buckets.delete(k);
  }

  /** Whether any value lies within `guard` of f. */
  near(f: number, guard: number): boolean {
    const k = Math.floor(f / this.bucketKHz);
    for (let b = k - 1; b <= k + 1; b++) {
      const arr = this.buckets.get(b);
      if (!arr) continue;
      for (const v of arr) if (Math.abs(v - f) <= guard) return true;
    }
    return false;
  }

  /** Distance to the nearest value, searching outward up to `limit` kHz. */
  nearest(f: number, limit: number): number | null {
    const k = Math.floor(f / this.bucketKHz);
    const span = Math.ceil(limit / this.bucketKHz);
    let best: number | null = null;
    for (let d = 0; d <= span; d++) {
      for (const b of d === 0 ? [k] : [k - d, k + d]) {
        const arr = this.buckets.get(b);
        if (!arr) continue;
        for (const v of arr) {
          const dist = Math.abs(v - f);
          if (best === null || dist < best) best = dist;
        }
      }
      // Buckets further out cannot hold anything closer than what a full
      // ring already found.
      if (best !== null && best <= d * this.bucketKHz) break;
    }
    return best;
  }
}

/** The products a new carrier f forms with the placed carriers. */
function productsWith(f: number, placed: number[], fifth: boolean, threeTx: boolean): number[] {
  const out: number[] = [];
  for (const a of placed) {
    out.push(2 * a - f, 2 * f - a, (a + f) / 2);
    if (fifth) out.push(3 * a - 2 * f, 3 * f - 2 * a, (2 * a + f) / 3, (2 * f + a) / 3, (3 * a - f) / 2, (3 * f - a) / 2);
  }
  if (!threeTx) return out;
  // Three-transmitter products involving f: f + a − b (ordered, a ≠ b) and
  // a + b − f (unordered). Both are permutations of the same sum-difference
  // form, so both orderings of the first cover everything once.
  for (let i = 0; i < placed.length; i++) {
    for (let j = 0; j < placed.length; j++) {
      if (i === j) continue;
      out.push(f + placed[i] - placed[j]);
    }
    for (let j = i + 1; j < placed.length; j++) {
      out.push(placed[i] + placed[j] - f);
    }
  }
  return out;
}

// ── Candidate grids ─────────────────────────────────────────────────────────

function candidateGrid(
  tx: CoordinationTransmitter, exclusions: Array<[number, number]>,
): number[] {
  const { segmentsKHz, stepKHz } = tx.profile;
  const excluded = (f: number) => exclusions.some(([lo, hi]) => f >= lo && f <= hi);
  const grid: number[] = [];
  for (const [lo, hi] of segmentsKHz) {
    // Snap to the step measured from the segment's own start: a band that
    // begins at 470.200 tunes 470.200, 470.800 … rather than 470.400.
    for (let f = lo; f <= hi + 1e-9; f += stepKHz) {
      const kHz = Math.round(f);
      if (!excluded(kHz)) grid.push(kHz);
    }
  }
  if (tx.currentKHz === undefined) return grid;
  // Current carrier first, then outward from it: the fewest and smallest
  // moves that still clear the rig.
  const cur = tx.currentKHz;
  return grid.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b);
}

function spacingBetween(a: CoordinationTransmitter, b: CoordinationTransmitter): number {
  const sa = a.dense && a.profile.spacingKHz.dense ? a.profile.spacingKHz.dense : a.profile.spacingKHz.standard;
  const sb = b.dense && b.profile.spacingKHz.dense ? b.profile.spacingKHz.dense : b.profile.spacingKHz.standard;
  // Two families with different rules: the larger figure is the one that is
  // conservative for both, and anything cleverer is unpublished.
  return Math.max(sa, sb);
}

// ── The search ──────────────────────────────────────────────────────────────

/**
 * Coordinate a rig.
 *
 * Deterministic: the same input gives the same plan, so a plan can be
 * regenerated and compared. Locked transmitters are placed first and never
 * moved; if two locked carriers conflict with each other that is reported,
 * not resolved.
 */
export function coordinate(input: CoordinationInput): CoordinationPlan {
  const mode = input.threeTx ?? 'preferred';
  if (mode === 'ignored') return solve(input, false);
  const strict = solve(input, true);
  if (mode === 'required' || strict.complete) return strict;
  // Could not be cleared of three-transmitter products: the plan that
  // clears two-transmitter products is still a plan, and a better one than
  // leaving transmitters unplaced. Only if it actually does better.
  const relaxed = solve(input, false);
  return relaxed.assignments.length > strict.assignments.length ? relaxed : strict;
}

function solve(input: CoordinationInput, threeTx: boolean): CoordinationPlan {
  const guard = input.guardKHz ?? DEFAULT_GUARD_KHZ;
  const fifth = input.includeFifthOrder ?? false;
  const maxNodes = input.maxNodes ?? DEFAULT_MAX_NODES;
  const exclusions = input.exclusionsKHz ?? [];

  const forbidden = new ForbiddenSet(Math.max(guard, 1) * 2);
  const placed: Array<{ tx: CoordinationTransmitter; kHz: number }> = [];
  const placedKHz = (): number[] => placed.map(p => p.kHz);

  const clears = (tx: CoordinationTransmitter, f: number): boolean => {
    for (const p of placed) {
      if (Math.abs(p.kHz - f) < spacingBetween(tx, p.tx)) return false;
    }
    return !forbidden.near(f, guard);
  };

  const place = (tx: CoordinationTransmitter, f: number) => {
    for (const v of productsWith(f, placedKHz(), fifth, threeTx)) forbidden.add(v);
    placed.push({ tx, kHz: f });
  };
  const unplace = () => {
    const { kHz } = placed.pop()!;
    for (const v of productsWith(kHz, placedKHz(), fifth, threeTx)) forbidden.remove(v);
  };

  const unassigned: CoordinationPlan['unassigned'] = [];

  // Locked carriers are constraints. A locked transmitter that is not on
  // the air cannot be a constraint on anything, so it is reported.
  const locked = input.transmitters.filter(t => t.locked);
  for (const tx of locked) {
    if (tx.currentKHz === undefined || tx.currentKHz <= 0) {
      unassigned.push({ id: tx.id, name: tx.name, reason: 'locked without a frequency' });
      continue;
    }
    if (!clears(tx, tx.currentKHz)) {
      unassigned.push({ id: tx.id, name: tx.name, reason: 'locked, and conflicts with another locked carrier' });
      continue;
    }
    place(tx, tx.currentKHz);
  }

  // Variables: most constrained first. Fewest candidates is the classic
  // ordering; ties broken by id so the result is stable.
  const free = input.transmitters
    .filter(t => !t.locked)
    .map(tx => ({ tx, grid: candidateGrid(tx, exclusions) }))
    .sort((a, b) => a.grid.length - b.grid.length || a.tx.id.localeCompare(b.tx.id));

  for (const v of free) {
    if (v.grid.length === 0) {
      unassigned.push({ id: v.tx.id, name: v.tx.name, reason: 'no legal frequency in its band outside the exclusions' });
    }
  }
  const vars = free.filter(v => v.grid.length > 0);

  let nodes = 0;
  let exhausted = false;
  // Best partial plan seen, by depth, for when the budget runs out.
  let best: Array<{ tx: CoordinationTransmitter; kHz: number }> = placed.slice();

  const search = (depth: number): boolean => {
    if (depth === vars.length) return true;
    if (nodes >= maxNodes) { exhausted = true; return false; }
    const { tx, grid } = vars[depth];
    for (const f of grid) {
      nodes++;
      if (nodes > maxNodes) { exhausted = true; return false; }
      if (!clears(tx, f)) continue;
      place(tx, f);
      if (placed.length > best.length) best = placed.slice();
      if (search(depth + 1)) return true;
      unplace();
      if (exhausted) return false;
    }
    return false;
  };

  const solved = search(0);
  const final = solved ? placed.slice() : best;

  if (!solved) {
    const got = new Set(final.map(p => p.tx.id));
    for (const v of vars) {
      if (!got.has(v.tx.id)) {
        unassigned.push({
          id: v.tx.id, name: v.tx.name,
          reason: exhausted ? 'search budget exhausted before it was placed' : 'no frequency clears the others',
        });
      }
    }
  }

  // Margin: rebuild the product set for the final carriers and find how
  // close any product comes to any carrier. Products a carrier makes with
  // itself are not findings (see intermod.ts).
  const carriers = final.map(p => p.kHz);
  const margin = worstMargin(carriers, { fifth, threeTx: false });
  const margin3 = worstMargin(carriers, { fifth: false, threeTx: true, twoTx: false });

  const assignments = final.map(({ tx, kHz }) => ({
    id: tx.id, name: tx.name, frequencyKHz: kHz,
    previousKHz: tx.currentKHz,
    moved: tx.currentKHz !== undefined && tx.currentKHz !== kHz,
    locked: !!tx.locked,
  }));

  return {
    assignments,
    unassigned,
    complete: unassigned.length === 0,
    worstMarginKHz: margin,
    worstThreeTxMarginKHz: margin3,
    moves: assignments.filter(a => a.moved).length,
    threeTxCleared: threeTx,
    nodesExplored: nodes,
    budgetExhausted: exhausted,
  };
}

/**
 * The closest any intermod product of these carriers comes to one of them,
 * kHz, over the product classes asked for. Null when there are too few
 * carriers to make a product of that class.
 */
export function worstMargin(
  carriers: number[],
  classes: { twoTx?: boolean; threeTx?: boolean; fifth?: boolean } = {},
): number | null {
  const twoTx = classes.twoTx ?? true;
  const threeTx = classes.threeTx ?? true;
  const fifth = classes.fifth ?? false;
  if (carriers.length < 2) return null;
  if (!twoTx && !fifth && (!threeTx || carriers.length < 4)) return null;
  let best: number | null = null;
  const consider = (product: number, victims: number[]) => {
    for (const v of victims) {
      const d = Math.abs(product - v);
      if (best === null || d < best) best = d;
    }
  };
  const n = carriers.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const others = carriers.filter((_, k) => k !== i && k !== j);
      if (twoTx) consider(2 * carriers[i] - carriers[j], others);
      if (fifth) consider(3 * carriers[i] - 2 * carriers[j], others);
      if (!threeTx) continue;
      for (let k = j + 1; k < n; k++) {
        if (k === i) continue;
        const rest = carriers.filter((_, m) => m !== i && m !== j && m !== k);
        consider(carriers[j] + carriers[k] - carriers[i], rest);
      }
    }
  }
  return best;
}
