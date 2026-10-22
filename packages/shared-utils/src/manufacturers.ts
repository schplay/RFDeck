// Devices an operator can add that RFDeck has no way to talk to: no public
// protocol, or one not built yet.
//
// The server must not contact them. Any client it started would never
// connect, and a device that never connects counts as missing, which keeps
// the recovery scan running for as long as the row exists. The app shows
// them as not supported rather than as offline, and says why.

/** Brands whose receivers RFDeck cannot talk to at all. */
export const UNSUPPORTED_MANUFACTURERS = ['Wisycom', 'Lectrosonics', 'Sony'] as const;

/**
 * Individual models of a supported brand that are not reachable.
 *
 * The EM 3731-II/3732-II talk only to Sennheiser's own Wireless Systems
 * Manager. Sennheiser's media control protocol (UDP 53212, what RFDeck speaks
 * to G3s) lists the EM 300/500 G3, EM 2000, EM 2050 and SR 2050 IEM as its
 * supported devices, and not the 3000 series ("Media control protocol
 * description", 2012).
 */
const UNSUPPORTED_MODELS: Array<{ manufacturer: RegExp; model: RegExp; name: string }> = [
  { manufacturer: /sennheiser/i, model: /\bEM\s?373[12]\b/i, name: 'the EM 3731/3732' },
];

/**
 * Why RFDeck cannot monitor this device, in a sentence ready to show, or null
 * when it can.
 */
export function unsupportedReason(
  manufacturer: string | null | undefined,
  model?: string | null,
): string | null {
  const brand = (manufacturer ?? '').trim();
  if (UNSUPPORTED_MANUFACTURERS.some(u => u.toLowerCase() === brand.toLowerCase())) {
    return `RFDeck cannot monitor ${brand} devices, so it does not contact this one.`;
  }
  const m = (model ?? '').trim();
  const known = UNSUPPORTED_MODELS.find(u => u.manufacturer.test(brand) && u.model.test(m));
  if (known) {
    return `RFDeck cannot monitor ${known.name}: it only talks to Sennheiser's own software, so RFDeck does not contact it.`;
  }
  return null;
}

export function isUnsupportedDevice(manufacturer: string | null | undefined, model?: string | null): boolean {
  return unsupportedReason(manufacturer, model) !== null;
}
