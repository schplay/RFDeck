import fs from 'fs';
import { log } from '../logger';
import { captureBackend, resolveFfmpeg, AudioInputDevice } from './backends';

// Audio capture devices on the machine running RFDeck.
//
// The interface with the receiver outputs is plugged into *this* machine — the
// rack server, or the laptop running the desktop build — not into whichever
// browser happens to be viewing the dashboard. So the device list comes from
// here and is offered to clients.
//
// What that means per operating system lives in ./backends. This file is the
// part that does not vary: cache the probe, report honestly when a width is
// unknown, and explain an empty list.

export type { AudioInputDevice } from './backends';

/** Used only when the hardware will not tell us; always paired with a warning. */
export const FALLBACK_CHANNELS = 2;

export function listAudioInputDevices(): AudioInputDevice[] {
  const backend = captureBackend();
  if (!backend.available()) return [];

  const devices = backend.listDevices();

  // Probe width only after de-duplicating — each probe opens the device.
  for (const d of devices) {
    const probed = probeChannelCount(d.id);
    d.channelsProbed = probed !== null;
    d.channels = probed ?? FALLBACK_CHANNELS;
  }
  return devices;
}

// How many input channels does this device actually have?
//
// There is no single answer to "how is a rig wired" — an interface might be a
// 2-channel USB box, a 32-channel Dante card, or the virtual RAVENNA device the
// AES67 daemon creates. So ask the device rather than assuming, and let the
// operator map any channel of any device.
//
// Returns null when the hardware will not say, rather than a plausible-looking
// default — callers must decide what to do about not knowing.
const channelCache = new Map<string, number | null>();

export function probeChannelCount(deviceId: string): number | null {
  const cached = channelCache.get(deviceId);
  if (cached !== undefined) return cached;

  const channels = captureBackend().probeChannels(deviceId);

  if (channels === null) {
    // Warn, not debug: this silently capped every device at the fallback
    // width once already, and it was invisible in the default log level.
    log.warn(
      `[audio] Could not read the channel count for ${deviceId}. ` +
      `Assuming ${FALLBACK_CHANNELS} inputs.`,
    );
  }

  // Cache only a real answer. A probe can fail for reasons that pass — most
  // commonly the device being held open by an active capture, since exclusive
  // access is the norm — and caching that failure for the life of the process
  // meant every later patch beyond the fallback width was refused.
  if (channels !== null) channelCache.set(deviceId, channels);
  return channels;
}

/** Forget cached probes so a re-scan re-reads hardware that has changed. */
export function clearChannelCache(): void {
  channelCache.clear();
}

/** A quick sanity check used by the API so the UI can explain an empty list. */
export function audioSubsystemPresent(): boolean {
  return captureBackend().available();
}

export function describeNoDevices(): string {
  const backend = captureBackend();
  if (!backend.available()) return backend.unavailableReason();

  if (backend.id === 'alsa') {
    return 'No capture devices found. Check the interface is connected and that ' +
           '"arecord -l" lists it on the server. For AES67, confirm the kernel ' +
           'module is loaded: lsmod | grep MergingRavenna';
  }
  return 'No capture devices found. Check the interface is connected and that ' +
         `${backend.label} lists it — an interface that is plugged in but has no ` +
         'driver loaded will not appear.';
}

// Can this process actually OPEN a capture device, as opposed to merely
// listing one?
//
// The two need different permissions on Linux: /proc/asound is world-readable,
// so enumeration succeeds for any user, while /dev/snd is group-owned by
// 'audio'. A service account outside that group therefore lists every card and
// can open none — which surfaced as devices appearing correctly but always
// reporting the fallback width.
//
// Nothing equivalent applies on Windows or macOS, where device access is not
// gated by a group, so this only reports a problem on Linux.
export function canOpenCaptureDevices(): boolean | null {
  if (captureBackend().id !== 'alsa') return null;

  let entries: string[];
  try {
    entries = fs.readdirSync('/dev/snd');
  } catch {
    return null;
  }

  const captureNodes = entries.filter(e => /^pcmC\d+D\d+c$/.test(e));
  if (captureNodes.length === 0) return null;

  return captureNodes.some(node => {
    try {
      fs.accessSync(`/dev/snd/${node}`, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Explains a device list that is present but unusable. Null when nothing is wrong. */
export function describeAccessProblem(): string | null {
  if (canOpenCaptureDevices() !== false) return null;
  return 'RFDeck can list capture devices but cannot open them, so channel ' +
         'counts fall back to a default and audio will not stream. The account ' +
         'running RFDeck is missing the "audio" group that owns /dev/snd. ' +
         'On the server: sudo usermod -aG audio rfdeck && sudo systemctl restart rfdeck';
}

/** Which backend is in use, for diagnostics and the settings page. */
export function backendSummary(): {
  id: string; label: string; available: boolean; reason: string | null; ffmpeg: string | null;
} {
  const b = captureBackend();
  return {
    id: b.id,
    label: b.label,
    available: b.available(),
    reason: b.available() ? null : b.unavailableReason(),
    ffmpeg: b.id === 'alsa' ? null : resolveFfmpeg(),
  };
}
