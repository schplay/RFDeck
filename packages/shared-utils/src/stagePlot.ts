/**
 * Stage-plot coordinates.
 *
 * A position is thousandths of the stage width and depth, 0–1000. A proportion
 * rather than pixels, because the plot is dragged on whatever screen is to hand and
 * read on another — pixels would put a performer somewhere else on a phone.
 *
 * **Integers, and that is load-bearing rather than tidiness.** Positions travel in
 * the show file, whose content hash is reproduced from a canonical JSON form to tell
 * a benign push conflict from a real one. PHP and JavaScript do not always render the
 * same float identically, so one float in a show file could make RFDeck and Meros
 * disagree about a document that is in fact the same. `showFile.test.ts` has a
 * tripwire for it, and this field is what set it off.
 *
 * Shared because the clamp has to be identical on both sides: the client clamps to
 * keep a card on screen, the server clamps because an out-of-range value would be
 * stored forever and put somebody off the plot.
 */

/** The coordinate space. 0 is upstage/stage-left edge, 1000 the opposite. */
export const STAGE_MAX = 1000;

/** The middle of the stage, where an unplaced performer is dropped. */
export const STAGE_CENTRE = STAGE_MAX / 2;

/**
 * Coerce anything into a stage coordinate, or null for "not placed".
 *
 * Null and undefined both mean unplaced and are preserved as null — never coerced to
 * 0, which would silently move a performer to a corner rather than leaving them off
 * the plot. A value that is not a finite number is treated the same way: guessing at
 * a position is worse than admitting there isn't one.
 */
export function stageCoord(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(STAGE_MAX, Math.max(0, n));
}

/**
 * Where a pointer landed, as a stage coordinate.
 *
 * Returns null for a zero-sized surface — which happens on first paint and while a
 * layout is settling, and would otherwise divide by zero and place everyone at the
 * origin.
 */
export function pointToStage(
  point: { x: number; y: number },
  surface: { left: number; top: number; width: number; height: number },
): { x: number; y: number } | null {
  if (!(surface.width > 0) || !(surface.height > 0)) return null;
  const x = stageCoord(((point.x - surface.left) / surface.width) * STAGE_MAX);
  const y = stageCoord(((point.y - surface.top) / surface.height) * STAGE_MAX);
  return x === null || y === null ? null : { x, y };
}

/**
 * Even positions for a whole cast, so a new plot is not thirty cards in one spot.
 *
 * Not a layout algorithm pretending to know the production. It exists because the
 * alternative first impression — everybody stacked in the middle — is what makes an
 * operator abandon the feature before trying it.
 */
export function arrangeEvenly(count: number): Array<{ x: number; y: number }> {
  if (count <= 0) return [];
  const perRow = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / perRow);
  return Array.from({ length: count }, (_, i) => ({
    // `+1` on both the index and the divisor insets the grid from the edges, so
    // nobody is placed half-off the stage.
    x: Math.round(((i % perRow) + 1) / (perRow + 1) * STAGE_MAX),
    y: Math.round(((Math.floor(i / perRow)) + 1) / (rows + 1) * STAGE_MAX),
  }));
}
