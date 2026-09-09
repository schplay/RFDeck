// Intermodulation: the frequencies a rig makes that nobody tuned it to.
//
// Two transmitters close together produce mixing products in any non-linear
// stage they share — a receiver front end, an antenna distro, a corroded
// connector. The third-order products are the ones that matter, because they
// land near the original carriers rather than far away, and they are strong
// enough to sit on top of a wanted signal.
//
// Coordination software exists to work this out before a show. RFDeck's angle
// is different and, for an operator, better: it already knows every frequency
// in the rig because the receivers told it, so there is nothing to type in and
// no chance of checking a plan that is not the one on the air. A coordination
// plan drifts from reality the moment somebody re-tunes a pack at the rack.
//
// What lands where is arithmetic and is not in doubt. What counts as "on top
// of" a channel is a judgement, so it is a parameter — see GUARD_KHZ.

/** A transmitter in the rig, as far as this calculation cares. */
export interface IntermodSource {
  id: string;
  name: string;
  /** kHz, matching Channel.frequency throughout RFDeck. */
  frequencyKHz: number;
}

export interface IntermodHit {
  /** The channel the product lands on. */
  victimId: string;
  victimName: string;
  /** Where the product falls, kHz. */
  productKHz: number;
  /** Signed distance from the victim's carrier, kHz. Negative is below. */
  offsetKHz: number;
  order: 3 | 5;
  /** Which combination produced it. */
  kind: '2TX3' | '3TX3' | '2TX5';
  /** The transmitters involved, in the order the formula uses them. */
  causeIds: string[];
  /** Readable form, e.g. "2×Vocal 1 − Vocal 2". */
  formula: string;
}

export interface IntermodOptions {
  /**
   * How close a product has to be to count as landing on a channel, kHz.
   *
   * Chosen from the receiver rather than from a standard: a product only
   * matters if it gets through the front end, and a typical wireless
   * microphone receiver passes roughly 200 kHz around its carrier. So ±100 kHz
   * is "inside the channel", and anything further out is rejected by the
   * receiver before it can do harm.
   *
   * It is a parameter because that figure is a generalisation. A narrowband
   * digital system wants less; a rig with a marginal antenna distro may want
   * more. Nothing here should pretend to a precision it does not have.
   */
  guardKHz?: number;
  /** Fifth-order products are far weaker; off unless asked for. */
  includeFifthOrder?: boolean;
  /**
   * Above this many transmitters, three-transmitter products are skipped.
   *
   * The three-transmitter search is cubic. At 60 carriers that is around
   * 200,000 combinations, which is nothing; at 250 it is 15 million, which is
   * long enough to stall the event loop on a server that is also carrying live
   * telemetry. Skipped loudly rather than quietly — see `truncated`.
   */
  maxSourcesForThreeTx?: number;
}

export const GUARD_KHZ = 100;
const MAX_SOURCES_FOR_THREE_TX = 80;

export interface IntermodReport {
  hits: IntermodHit[];
  /** True when the rig was too large to check three-transmitter products. */
  truncated: boolean;
  /** How many carriers were considered. */
  sourceCount: number;
}

/**
 * Every third-order product that lands on a channel in this rig.
 *
 * Third order, two transmitters:   2·f1 − f2
 * Third order, three transmitters: f1 + f2 − f3
 * Fifth order, two transmitters:   3·f1 − 2·f2   (optional)
 *
 * A product landing on the transmitter that produced it is not reported: the
 * arithmetic is real but the finding is not, since the channel is already
 * transmitting there. Only products from *other* carriers are a problem.
 */
export function findIntermodHits(
  sources: IntermodSource[],
  options: IntermodOptions = {},
): IntermodReport {
  const guard = options.guardKHz ?? GUARD_KHZ;
  const maxThreeTx = options.maxSourcesForThreeTx ?? MAX_SOURCES_FOR_THREE_TX;

  // A carrier of zero or less is a channel that has not reported a frequency
  // yet, not one sitting at DC. Including it would invent products across the
  // whole band.
  const tx = sources.filter(s => Number.isFinite(s.frequencyKHz) && s.frequencyKHz > 0);
  const hits: IntermodHit[] = [];

  const record = (
    productKHz: number,
    order: 3 | 5,
    kind: IntermodHit['kind'],
    causes: IntermodSource[],
    formula: string,
  ) => {
    for (const victim of tx) {
      // A product made partly by the victim itself is not a finding about the
      // victim — it is that carrier's own energy coming back round.
      if (causes.some(c => c.id === victim.id)) continue;
      const offset = productKHz - victim.frequencyKHz;
      if (Math.abs(offset) > guard) continue;
      hits.push({
        victimId: victim.id,
        victimName: victim.name,
        productKHz,
        offsetKHz: offset,
        order,
        kind,
        causeIds: causes.map(c => c.id),
        formula,
      });
    }
  };

  // 2·f1 − f2. Ordered pairs: 2A−B and 2B−A are different products.
  for (const a of tx) {
    for (const b of tx) {
      if (a.id === b.id) continue;
      record(2 * a.frequencyKHz - b.frequencyKHz, 3, '2TX3', [a, b],
        `2×${a.name} − ${b.name}`);
      if (options.includeFifthOrder) {
        record(3 * a.frequencyKHz - 2 * b.frequencyKHz, 5, '2TX5', [a, b],
          `3×${a.name} − 2×${b.name}`);
      }
    }
  }

  // f1 + f2 − f3. f1 and f2 commute, so pairs are taken once.
  const truncated = tx.length > maxThreeTx;
  if (!truncated) {
    for (let i = 0; i < tx.length; i++) {
      for (let j = i + 1; j < tx.length; j++) {
        for (const c of tx) {
          if (c.id === tx[i].id || c.id === tx[j].id) continue;
          record(
            tx[i].frequencyKHz + tx[j].frequencyKHz - c.frequencyKHz,
            3, '3TX3', [tx[i], tx[j], c],
            `${tx[i].name} + ${tx[j].name} − ${c.name}`,
          );
        }
      }
    }
  }

  // Closest first: the operator wants the worst one, not the first one found.
  hits.sort((x, y) => Math.abs(x.offsetKHz) - Math.abs(y.offsetKHz));

  return { hits, truncated, sourceCount: tx.length };
}

/** The hits affecting one channel, for a per-channel warning. */
export function hitsForChannel(report: IntermodReport, channelId: string): IntermodHit[] {
  return report.hits.filter(h => h.victimId === channelId);
}

/**
 * A stable signature of what this calculation depends on.
 *
 * The search is cubic in the worst case, and telemetry arrives several times a
 * second — but frequencies change only when somebody re-tunes something. This
 * is what lets the result be cached until the rig actually moves.
 */
export function intermodSignature(sources: IntermodSource[]): string {
  return sources
    .filter(s => s.frequencyKHz > 0)
    .map(s => `${s.id}@${s.frequencyKHz}`)
    .sort()
    .join('|');
}
