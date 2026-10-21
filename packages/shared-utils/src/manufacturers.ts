// Manufacturers an operator can pick when adding a device, whose receivers
// RFDeck has no way to talk to: no public protocol, or one not built yet.
//
// The server must not contact them. Any client it started would never
// connect, and a device that never connects counts as missing, which keeps
// the recovery scan running for as long as the row exists. The app shows
// them as not supported rather than as offline.
export const UNSUPPORTED_MANUFACTURERS = ['Wisycom', 'Lectrosonics', 'Sony'] as const;

export function isUnsupportedManufacturer(manufacturer: string | null | undefined): boolean {
  const m = (manufacturer ?? '').trim().toLowerCase();
  return UNSUPPORTED_MANUFACTURERS.some(u => u.toLowerCase() === m);
}
