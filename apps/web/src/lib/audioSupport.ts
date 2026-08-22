import { serverOrigin } from './api';

// Where does monitored audio actually come from?
//
// RFDeck runs in two shapes, and they invert this question:
//
//   Desktop, or a browser on the server itself — the machine running RFDeck is
//   the machine with the audio interface plugged into it, so capturing through
//   the browser captures the right hardware.
//
//   Any other browser on the network — the interface is in the rack, attached
//   to the server. Capturing through the browser would capture *that laptop's*
//   built-in microphone, which is not audio anyone wants to hear. Audio has to
//   be captured on the server and streamed out, which is what AES67Manager and
//   the WebRTC bridge do.
//
// Getting this backwards is not a subtle bug: FOH would click Listen and hear
// the room through their own laptop mic.

export type AudioMode =
  // Capture through this browser — it is on the machine with the hardware.
  | { mode: 'local-capture'; available: true }
  // Audio is captured on the server and streamed here.
  | { mode: 'server-stream'; available: true }
  // Local capture is the right model here, but the browser will not allow it.
  | { mode: 'local-capture'; available: false; reason: 'insecure-context' | 'unsupported'; detail: string };

export type AudioSupport = AudioMode;

// Is the RFDeck server on this same machine?
//
// True for the desktop app (which loads from file:// and talks to localhost)
// and for a browser opened on the server itself. False for every other client,
// which is the normal case for a headless deployment.
export function isServerLocal(): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(serverOrigin());
}

function browserCaptureAvailable(): { ok: true } | { ok: false; reason: 'insecure-context' | 'unsupported'; detail: string } {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { ok: false, reason: 'unsupported', detail: 'No browser environment.' };
  }

  // The DOM types declare mediaDevices as always present, but browsers omit it
  // outside a secure context — so this has to be a runtime check TypeScript
  // cannot optimise away.
  const md = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
  if (typeof md?.enumerateDevices === 'function') return { ok: true };

  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'insecure-context',
      detail:
        'Browsers only expose audio devices to pages served over HTTPS, or from ' +
        'localhost. This page was loaded over plain HTTP, so audio capture is ' +
        'unavailable here.',
    };
  }

  return {
    ok: false,
    reason: 'unsupported',
    detail: 'This browser does not provide the audio capture API.',
  };
}

export function checkAudioSupport(): AudioSupport {
  // A remote client never captures locally, so the browser's capture API is
  // irrelevant to it — audio arrives over WebRTC from the server.
  if (!isServerLocal()) {
    return { mode: 'server-stream', available: true };
  }

  const capture = browserCaptureAvailable();
  if (capture.ok) return { mode: 'local-capture', available: true };

  return {
    mode: 'local-capture',
    available: false,
    reason: capture.reason,
    detail: capture.detail,
  };
}

export const audioSupport = checkAudioSupport();

// Should this client open a capture stream through the browser?
// Only when the hardware is on this machine AND the browser will allow it.
export function canCaptureLocally(s: AudioSupport = audioSupport): boolean {
  return s.mode === 'local-capture' && s.available;
}
