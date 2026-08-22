// Can this browser capture audio at all, and if not, why?
//
// `navigator.mediaDevices` only exists in a **secure context**: an HTTPS page,
// or one served from localhost. A headless RFDeck server is normally reached at
// something like http://192.168.1.50, which is neither — so the whole API is
// absent, not merely permission-denied.
//
// That caught us out on the Settings page: it called
// `navigator.mediaDevices.addEventListener(...)` unguarded and the page died
// with "Cannot read properties of undefined". The absence looks like a missing
// soundcard, but hardware has nothing to do with it — the same machine serving
// over HTTPS, or viewed at localhost, exposes the API normally.

export type AudioSupport =
  | { available: true }
  | { available: false; reason: 'insecure-context' | 'unsupported'; detail: string };

export function checkAudioSupport(): AudioSupport {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { available: false, reason: 'unsupported', detail: 'No browser environment.' };
  }

  // The DOM types declare mediaDevices as always present, but the browser
  // genuinely omits it outside a secure context — so this has to be a runtime
  // check that TypeScript cannot optimise away.
  const md = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
  if (typeof md?.enumerateDevices === 'function') {
    return { available: true };
  }

  // Distinguish "the browser withheld it because the page is not secure" from
  // "this browser genuinely has no support", because only the first is fixable.
  if (!window.isSecureContext) {
    return {
      available: false,
      reason: 'insecure-context',
      detail:
        'Browsers only expose audio devices to pages served over HTTPS, or from ' +
        'localhost. This page was loaded over plain HTTP from a network address, ' +
        'so audio monitoring is unavailable here.',
    };
  }

  return {
    available: false,
    reason: 'unsupported',
    detail: 'This browser does not provide the audio capture API.',
  };
}

export const audioSupport = checkAudioSupport();
