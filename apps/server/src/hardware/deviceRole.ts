// Is this device a microphone receiver or an IEM transmitter?
//
// It matters more than it looks. An IEM transmitter receives nothing, so it
// has no RF and no transmitter battery; filed as a microphone it sits at 0% RF
// raising dropout alerts, and it clutters the soundcheck list with rows nobody
// is speaking into.
//
// RFDeck asks the operator on the add-device form, and the answer defaults to
// "input". That default is wrong for every IEM, and a device added straight
// from the discovery list never gets asked at all — so an entire monitor rig
// ends up filed as microphones, silently, and the IEM column stays empty with
// nothing to explain why.
//
// Where the model says plainly what a device is, RFDeck should not need to be
// told. The operator's explicit choice still wins; this only fills in a blank.

export type DeviceRole = 'input' | 'output';

/**
 * Model and name patterns that unambiguously name an IEM transmitter.
 *
 * Deliberately narrow. A false positive files a working microphone as a
 * monitor feed and suppresses its dropout alerting, which is far worse than
 * failing to classify and leaving the operator to say so.
 */
const IEM_PATTERNS: RegExp[] = [
  // Sennheiser: "ew IEM G4", "SR IEM", "EW-D IEM"; the word is unambiguous.
  /\bIEM\b/i,
  // Sennheiser stereo transmitters: SR 2000, SR 2050, SR 300 G4.
  /\bSR\s?\d{3,4}\b/i,
  // Shure personal monitors: PSM 300/900/1000, and the P10T/P9T/P3T packs.
  /\bPSM\s?\d{3,4}\b/i,
  /\bP\d{1,2}T\b/i,
  // Sennheiser's 2000-series IEM transmitter.
  /\bSR\s?2050\b/i,
];

/**
 * Patterns that name a *receiver*, checked first.
 *
 * Some model strings carry both halves of a system — "ew 300 IEM G3" names the
 * IEM, but a full system name like "EM 2050" is a receiver. Anything that
 * clearly names a receiver is never reclassified.
 */
const RECEIVER_PATTERNS: RegExp[] = [
  // Sennheiser receivers: EM 2050, EM 6000, EM 9046, and EW-DX's EM 2 / EM 4.
  // One digit is a real model number here, so the count starts at one — an
  // earlier version required two and quietly failed to recognise every EW-DX.
  // "IEM" cannot match it: the EM there is not at a word boundary.
  /\bEM\s?\d{1,4}\b/i,
  // Shure receivers.
  /\bAD4[DQ]\b|\bULXD4\w*\b|\bQLXD4\b|\bSLXD4\w*\b/i,
];

/**
 * What this device most likely is, or null when the model does not say.
 *
 * Null means "ask" rather than "input" — the caller decides what to do with
 * not knowing, and should not have that decision made for it here.
 */
export function inferDeviceRole(model?: string | null, name?: string | null): DeviceRole | null {
  const haystack = `${model ?? ''} ${name ?? ''}`.trim();
  if (!haystack) return null;

  // A receiver that happens to mention IEM — a system name, a location label
  // like "Rack 2 (next to IEM)" — must not be reclassified.
  if (RECEIVER_PATTERNS.some(re => re.test(haystack))) return 'input';

  if (IEM_PATTERNS.some(re => re.test(haystack))) return 'output';

  return null;
}

/** Convenience for the places that only care whether it is an IEM. */
export function looksLikeIem(model?: string | null, name?: string | null): boolean {
  return inferDeviceRole(model, name) === 'output';
}

/**
 * Does this model name a device that speaks Sennheiser SSC over HTTPS?
 *
 * Used to decide whether the SSCv2 → G3/G4 fallback applies. That fallback is
 * how a G3 is recognised at all — an SSC probe fails and MCP is tried instead
 * — but it is a one-way door: it stops the SSC client and starts an MCP one,
 * and MCP cannot talk to an EW-DX. A single transient disconnect during the
 * probe therefore left an EW-DX permanently on a client that could never
 * reach it, and every re-track repeated the race.
 *
 * So a device the inventory already identifies as an SSC receiver never takes
 * that door. It keeps retrying as SSC, which is what it is.
 */
export function isSscModel(model?: string | null): boolean {
  const m = (model ?? '').trim();
  if (!m) return false;
  // EW-DX and EW-D, and the EM-series receivers -- but not "EW G3/G4",
  // which is exactly the device the fallback exists for.
  if (/\bEW[\s-]?DX\b|\bEW[\s-]?D\b|\bEWDX\b/i.test(m)) return true;
  if (/\bEM\s?\d{1,4}\b/i.test(m)) return true;
  return false;
}


/**
 * Is this model string a stand-in rather than a real model?
 *
 * The add form fills in `"<Manufacturer> Device"` when the field is left
 * blank, and discovery falls back to labels like "Unknown Model". Those look
 * like data and are not: they tell RFDeck nothing about what the device is,
 * and code that keys on the model — which client to build, whether the G3/G4
 * fallback applies — is quietly blinded by them.
 *
 * Devices report their own model once connected. Where the stored value is one
 * of these placeholders, the device's answer is better and replaces it. A
 * model an operator actually typed is never touched.
 */
export function isPlaceholderModel(model?: string | null, manufacturer?: string | null): boolean {
  const m = (model ?? '').trim();
  if (!m) return true;
  if (/^unknown\b/i.test(m)) return true;
  // "Sennheiser Device", "Shure Device" — what the add form generates from the
  // manufacturer when no model is given.
  if (/^\s*\S+\s+device\s*$/i.test(m)) return true;
  const vendor = (manufacturer ?? '').trim();
  if (vendor && m.toLowerCase() === `${vendor.toLowerCase()} device`) return true;
  return false;
}
