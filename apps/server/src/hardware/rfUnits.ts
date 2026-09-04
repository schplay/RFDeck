// How RFDeck turns a receiver's RF level into the 0–100 its meters show.
//
// Every manufacturer reports RF differently — Shure as an offset integer that
// converts to dBm, Sennheiser's Digital 6000 as a byte with its own formula,
// Sennheiser's EW-DX as a quality percentage it has already computed. The
// first two are the same physical quantity, so they should land on the same
// scale rather than each inventing one.
//
// This is that one place. Convert to real dBm in the vendor's own module, then
// bring it here.

/**
 * The dBm window mapped onto 0–100.
 *
 * Chosen for where it leaves the thresholds the rest of the application
 * already uses, not for mathematical tidiness. A wireless receiver squelches
 * somewhere around -95 dBm, a well-set-up link sits between -60 and -40, and
 * above -35 is as good as it gets.
 *
 *   RFDeck calls a channel CRITICAL below 20%  ->  exactly -83 dBm, near squelch
 *   ...and marginal below 35%                  ->  exactly -74 dBm, worth watching
 *   A healthy -50 dBm link reads 75%, which looks healthy on a meter.
 */
export const RF_FLOOR_DBM = -95;
export const RF_CEILING_DBM = -35;

export function dbmToPercent(dbm: number): number {
  const span = RF_CEILING_DBM - RF_FLOOR_DBM;
  const pct = Math.round(((dbm - RF_FLOOR_DBM) / span) * 100);
  return Math.min(100, Math.max(0, pct));
}
